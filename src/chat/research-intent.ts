import { z } from "zod"
import { GENERATED_CHAIN_SLUGS } from "../lib/chains.generated.js"
import { normalizeChainSlug, validateAddress } from "../lib/chains.js"
import { sanitizeOperatorText } from "./prompt.js"
import {
  ALL_CHAIN_WORDS_RE,
  CHAIN_ALIASES,
  CHAIN_CA,
  ON_CHAIN_RE,
  RESEARCH_VERBS,
  normalizeChainWord,
  solanaCaFrom,
  type ChainHint,
} from "./research-intent-core.js"

export const ResearchIntentKindSchema = z.enum(["chat", "research"])
export type ResearchIntentKind = z.infer<typeof ResearchIntentKindSchema>

export const ResearchIntentSchema = z.object({
  schema: z.literal(1),
  kind: ResearchIntentKindSchema,
  subject: z.string().min(1).max(256).optional(),
  chainHint: z.enum(GENERATED_CHAIN_SLUGS as unknown as [string, ...string[]]).optional(),
  tokenHint: z.string().min(32).max(128).optional(),
  confidence: z.number().int().min(0).max(100).default(0),
})
export type ResearchIntent = z.infer<typeof ResearchIntentSchema>

const CONFIRM_RE = /^(confirm|yes|y|do\s+it|go\s+ahead|approved?)\s*[!.]*$/iu
const CANCEL_RE = /^(cancel|no|n|never\s*mind|abort|stop)\s*[!.]*$/iu
const EVM_CA = /\b(0x[a-fA-F0-9]{40})\b/u
const TICKER_RE = /\$([A-Za-z][A-Za-z0-9]{1,15})\b/u
const FILLER = /\b(perform|run|please|pls|for\s+me|can\s+you|could\s+you|would\s+you|the\s+token|deep|on|about|into|for|a|an|the)\b/giu

/** Fail-closed: anything not a strict research intent becomes chat */
export function parseResearchIntent(raw: string): ResearchIntent {
  const trimmed = raw.trim()
  try {
    const jsonStart = trimmed.indexOf("{")
    const jsonEnd = trimmed.lastIndexOf("}")
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const parsed = ResearchIntentSchema.safeParse(
        JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)),
      )
      if (parsed.success) {
        if (parsed.data.kind === "research" && !parsed.data.subject?.trim()) {
          return { schema: 1, kind: "chat", confidence: 0 }
        }
        return parsed.data
      }
    }
  } catch {
    // fall through
  }
  return { schema: 1, kind: "chat", confidence: 0 }
}

export function isConfirmText(text: string): boolean {
  return CONFIRM_RE.test(text.trim())
}

export function isCancelText(text: string): boolean {
  return CANCEL_RE.test(text.trim())
}

export function chainHintFrom(text: string): ResearchIntent["chainHint"] | undefined {
  const onChain = text.match(ON_CHAIN_RE)?.[1]
  if (onChain) return normalizeChainWord(onChain)
  for (const [re, chain] of CHAIN_ALIASES) {
    if (re.test(text)) return chain
  }
  return undefined
}

function tokenHintFrom(text: string): string | undefined {
  const chained = text.match(CHAIN_CA)
  if (chained?.[2]) return chained[2]
  const evm = text.match(EVM_CA)
  if (evm?.[1]) return evm[1]
  return solanaCaFrom(text)
}

function subjectFrom(text: string, tokenHint?: string, chainHint?: string): string {
  if (tokenHint && chainHint) return `${chainHint}:${tokenHint}`
  if (tokenHint) return tokenHint
  const ticker = text.match(TICKER_RE)?.[1]
  if (ticker) return ticker.toUpperCase()
  const cleaned = text
    .replace(RESEARCH_VERBS, " ")
    .replace(ON_CHAIN_RE, " ")
    .replace(ALL_CHAIN_WORDS_RE, " ")
    .replace(FILLER, " ")
    .replace(/\([^)]*\)/gu, " ")
    .replace(/[?!.,$]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
  return cleaned.slice(0, 256) || text.slice(0, 256)
}

/**
 * Host-side fail-closed extractor. Only clear research-shaped operator text
 * becomes a proposal; everything else stays chat.
 */
export function extractResearchIntent(operatorText: string): ResearchIntent {
  const text = sanitizeOperatorText(operatorText)
  if (!text || isConfirmText(text) || isCancelText(text)) {
    return { schema: 1, kind: "chat", confidence: 0 }
  }

  const chainCa = text.match(CHAIN_CA)
  if (chainCa?.[1] && chainCa[2]) {
    const normalized = normalizeChainSlug(chainCa[1]) as ChainHint | undefined
    if (!normalized) return { schema: 1, kind: "chat", confidence: 0 }
    return {
      schema: 1,
      kind: "research",
      subject: `${normalized}:${chainCa[2]}`,
      chainHint: normalized,
      tokenHint: chainCa[2],
      confidence: 95,
    }
  }

  const tokenHint = tokenHintFrom(text)
  const chainHint = chainHintFrom(text)
  const wantsResearch = RESEARCH_VERBS.test(text)
    || Boolean(tokenHint)
    || /^\/research\b/iu.test(text)

  if (!wantsResearch) {
    return { schema: 1, kind: "chat", confidence: 0 }
  }

  if (!RESEARCH_VERBS.test(text) && !tokenHint && !/^\/research\b/iu.test(text)) {
    return { schema: 1, kind: "chat", confidence: 0 }
  }

  const subjectSource = text.replace(/^\/research\s+/iu, "").trim() || text
  const subject = subjectFrom(subjectSource, tokenHint, chainHint)
  if (subject.length < 2) {
    return { schema: 1, kind: "chat", confidence: 0 }
  }

  return {
    schema: 1,
    kind: "research",
    subject,
    ...(chainHint ? { chainHint } : {}),
    ...(tokenHint ? { tokenHint } : {}),
    confidence: tokenHint ? 90 : chainHint ? 80 : 70,
  }
}

export function researchConfirmPrompt(intent: ResearchIntent): string {
  const subject = intent.subject ?? "unknown"
  const bits = intent.chainHint
    ? [`Research ${subject} on ${intent.chainHint}?`]
    : [`Research ${subject}?`]
  bits.push("Reply confirm or cancel.")
  return bits.join(" ")
}

// silence unused import warning for validateAddress re-export consumers
void validateAddress

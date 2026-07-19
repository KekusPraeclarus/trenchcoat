import { z } from "zod"
import { validateAddress } from "../lib/chains.js"
import { sanitizeOperatorText } from "./prompt.js"

export const ResearchIntentKindSchema = z.enum(["chat", "research"])
export type ResearchIntentKind = z.infer<typeof ResearchIntentKindSchema>

export const ResearchIntentSchema = z.object({
  schema: z.literal(1),
  kind: ResearchIntentKindSchema,
  subject: z.string().min(1).max(256).optional(),
  chainHint: z.enum(["solana", "ethereum", "base", "bsc", "robinhood"]).optional(),
  tokenHint: z.string().min(32).max(128).optional(),
  confidence: z.number().int().min(0).max(100).default(0),
})
export type ResearchIntent = z.infer<typeof ResearchIntentSchema>

const CHAIN_ALIASES: ReadonlyArray<[RegExp, NonNullable<ResearchIntent["chainHint"]>]> = [
  [/\b(solana|sol)\b/iu, "solana"],
  [/\b(ethereum|eth)\b/iu, "ethereum"],
  [/\b(base)\b/iu, "base"],
  [/\b(bsc|bnb)\b/iu, "bsc"],
  [/\b(robinhood|hood)\b/iu, "robinhood"],
]

/** Prefer explicit "on <chain>" so "eth on base" resolves to base */
const ON_CHAIN_RE = /\bon\s+(solana|sol|ethereum|eth|base|bsc|bnb|robinhood|hood)\b/iu
const ALL_CHAIN_WORDS_RE = /\b(solana|sol|ethereum|eth|base|bsc|bnb|robinhood|hood)\b/giu

const RESEARCH_VERBS = /\b(research|deep\s+research|look\s*into|deep[\s-]?dive|investigate|dig\s+into|check\s+out|analyse|analyze)\b/iu
const CONFIRM_RE = /^(confirm|yes|y|do\s+it|go\s+ahead|approved?)\s*[!.]*$/iu
const CANCEL_RE = /^(cancel|no|n|never\s*mind|abort|stop)\s*[!.]*$/iu
const CHAIN_CA = /^(solana|ethereum|base|bsc|robinhood):([A-Za-z0-9]{32,128})$/iu
const EVM_CA = /\b(0x[a-fA-F0-9]{40})\b/u
/** Base58 mint/pool ids; validated with chains.validateAddress before use */
const SOLANA_CA = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/gu
const TICKER_RE = /\$([A-Za-z][A-Za-z0-9]{1,15})\b/u
const FILLER = /\b(perform|run|please|pls|for\s+me|can\s+you|could\s+you|would\s+you|the\s+token|deep|on|about|into|for|a|an|the)\b/giu

function normalizeChainWord(word: string): NonNullable<ResearchIntent["chainHint"]> | undefined {
  const lower = word.toLowerCase()
  if (lower === "sol" || lower === "solana") return "solana"
  if (lower === "eth" || lower === "ethereum") return "ethereum"
  if (lower === "base") return "base"
  if (lower === "bsc" || lower === "bnb") return "bsc"
  if (lower === "hood" || lower === "robinhood") return "robinhood"
  return undefined
}

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

function solanaCaFrom(text: string): string | undefined {
  for (const match of text.matchAll(SOLANA_CA)) {
    const candidate = match[1]
    if (candidate && validateAddress("base58-32", candidate)) return candidate
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
    const chain = chainCa[1].toLowerCase() as NonNullable<ResearchIntent["chainHint"]>
    return {
      schema: 1,
      kind: "research",
      subject: `${chain}:${chainCa[2]}`,
      chainHint: chain,
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

  // Bare ticker without a research verb stays chat — too ambiguous
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

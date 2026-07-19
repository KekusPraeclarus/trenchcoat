import { validateAddress } from "../lib/chains.js"
import {
  allValidCasFrom,
  chainHintFrom,
  CHAIN_CA,
  normalizeChainWord,
  RESEARCH_VERBS,
  solanaCaFrom,
  stripDiscordFormatting,
} from "../chat/research-intent-core.js"

export type DiscordResearchIntent =
  | { kind: "ignore" }
  | { kind: "research"; subject: string; chainHint?: string; tokenHint?: string }
  | { kind: "renew"; anchorMessageId: string }

const RENEW_RE = /^(?:renew(?:\s+watch)?|keep\s+watching)\s*[!.]*$/iu

export function isRenewText(text: string): boolean {
  return RENEW_RE.test(stripDiscordFormatting(text))
}

export function extractDiscordResearchIntent(raw: string): DiscordResearchIntent {
  const text = stripDiscordFormatting(raw)
  if (!text) return { kind: "ignore" }

  const chainCa = text.match(CHAIN_CA)
  if (chainCa?.[1] && chainCa[2]) {
    const chain = chainCa[1].toLowerCase()
    const token = chainCa[2]
    const normalized = normalizeChainWord(chain)
    if (!normalized) return { kind: "ignore" }
    if (!validateAddressForChain(normalized, token)) return { kind: "ignore" }
    return {
      kind: "research",
      subject: `${normalized}:${token}`,
      chainHint: normalized,
      tokenHint: token,
    }
  }

  const cas = allValidCasFrom(text)
  if (cas.length > 1) return { kind: "ignore" }
  if (cas.length === 0) {
    if (!RESEARCH_VERBS.test(text)) return { kind: "ignore" }
    return { kind: "ignore" }
  }

  const tokenHint = cas[0]!
  const chainHint = chainHintFrom(text)
  const hasVerb = RESEARCH_VERBS.test(text)
  const isBareCa = text.replace(/[?.!,]/gu, "").trim() === tokenHint
    || text.replace(/[?.!,]/gu, "").trim().toLowerCase() === tokenHint.toLowerCase()

  if (!hasVerb && !isBareCa) return { kind: "ignore" }

  if (chainHint && !validateAddressForChain(chainHint, tokenHint)) {
    return { kind: "ignore" }
  }

  if (chainHint) {
    return {
      kind: "research",
      subject: `${chainHint}:${tokenHint}`,
      chainHint,
      tokenHint,
    }
  }

  if (tokenHint.startsWith("0x")) {
    return { kind: "research", subject: tokenHint, tokenHint }
  }
  if (validateAddress("base58-32", tokenHint)) {
    return {
      kind: "research",
      subject: `solana:${tokenHint}`,
      chainHint: "solana",
      tokenHint,
    }
  }
  return { kind: "ignore" }
}

function validateAddressForChain(chain: string, token: string): boolean {
  if (chain === "solana") return validateAddress("base58-32", token)
  if (chain === "robinhood") return validateAddress("base58-32", token) || validateAddress("evm", token)
  return validateAddress("evm", token)
}

export function isEvmToken(token: string): boolean {
  return validateAddress("evm", token)
}

export function bareSolanaFrom(text: string): string | undefined {
  return solanaCaFrom(text)
}

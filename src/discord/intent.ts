import {
  getChain,
  normalizeChainSlug,
  parseChainCa,
  validateAddress,
  CHAIN_SLUG_RE,
} from "../lib/chains.js"
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
  | {
    kind: "chain-integration"
    slug: string
    tokenAddress: string
    subject: string
  }
  | { kind: "renew"; anchorMessageId: string }

const RENEW_RE = /^(?:renew(?:\s+watch)?|keep\s+watching)\s*[!.]*$/iu

export function isRenewText(text: string): boolean {
  return RENEW_RE.test(stripDiscordFormatting(text))
}

/**
 * Discord research / chain-integration intake.
 * Exact unknown slug:address (optional research verb) → chain-integration.
 * Known chain:CA / bare CA / natural research phrasing → research.
 * Everything else → ignore.
 */
export function extractDiscordResearchIntent(raw: string): DiscordResearchIntent {
  const text = stripDiscordFormatting(raw)
  if (!text) return { kind: "ignore" }

  // Exact chain:CA first — known → research; unknown slug → integration
  const generic = parseChainCa(text)
  if (generic) {
    if (!CHAIN_SLUG_RE.test(generic.chainRaw)) return { kind: "ignore" }
    const known = normalizeChainSlug(generic.chainRaw)
    if (known && getChain(known)) {
      if (!validateAddressForChain(known, generic.token)) return { kind: "ignore" }
      return {
        kind: "research",
        subject: `${known}:${generic.token}`,
        chainHint: known,
        tokenHint: generic.token,
      }
    }
    // Unknown slug: only exact chain:CA (optionally verb-prefixed) triggers integration
    if (!validateAddress("evm", generic.token) && !validateAddress("base58-32", generic.token)) {
      return { kind: "ignore" }
    }
    // Reject if extra chatter beyond verb + chain:CA
    const stripped = text
      .replace(RESEARCH_VERBS, " ")
      .replace(/`/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
    const exact = `${generic.chainRaw}:${generic.token}`
    if (stripped.toLowerCase() !== exact.toLowerCase()) return { kind: "ignore" }
    return {
      kind: "chain-integration",
      slug: generic.chainRaw,
      tokenAddress: generic.token,
      subject: `${generic.chainRaw}:${generic.token}`,
    }
  }

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
  const entry = getChain(chain)
  if (!entry) return validateAddress("evm", token)
  if (chain === "robinhood") {
    return validateAddress("base58-32", token) || validateAddress("evm", token)
  }
  return validateAddress(entry.addressFormat, token)
}

export function isEvmToken(token: string): boolean {
  return validateAddress("evm", token)
}

export function bareSolanaFrom(text: string): string | undefined {
  return solanaCaFrom(text)
}

import {
  getChain,
  normalizeChainSlug,
  parseChainCa,
  validateAddress,
  knownChainSlugsAlternation,
  CHAIN_REGISTRY,
  type ChainSlug,
} from "../lib/chains.js"

export type ChainHint = ChainSlug

export const CHAIN_HINT_VALUES: readonly ChainHint[] = CHAIN_REGISTRY.map((c) => c.slug as ChainHint)

function buildAliasPairs(): ReadonlyArray<[RegExp, ChainHint]> {
  const pairs: Array<[RegExp, ChainHint]> = []
  for (const entry of CHAIN_REGISTRY) {
    const words = [entry.slug, ...entry.aliases]
    const alt = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")
    pairs.push([new RegExp(`\\b(${alt})\\b`, "iu"), entry.slug as ChainHint])
  }
  return pairs
}

export const CHAIN_ALIASES: ReadonlyArray<[RegExp, ChainHint]> = buildAliasPairs()

const ALT = knownChainSlugsAlternation()
export const ON_CHAIN_RE = new RegExp(`\\bon\\s+(${ALT})\\b`, "iu")
export const ALL_CHAIN_WORDS_RE = new RegExp(`\\b(${ALT})\\b`, "giu")
export const RESEARCH_VERBS =
  /\b(research|deep\s+research|look\s*into|deep[\s-]?dive|investigate|dig\s+into|check\s+out|analyse|analyze)\b/iu

/** Known-chain:CA (registry-derived). Unknown slugs use parseChainCa / CHAIN_CA_GENERIC_RE. */
export const CHAIN_CA = new RegExp(
  `^(?:<@!?&?\\d+>\\s*)?(?:(?:research|deep\\s+research|look\\s*into|investigate|analyse|analyze|check\\s+out|deep[\\s-]?dive)\\s+)?(?:\`)?(${ALT}):([A-Za-z0-9]{32,128})(?:\`)?$`,
  "iu",
)

export const EVM_CA = /\b(0x[a-fA-F0-9]{40})\b/gu
export const SOLANA_CA = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/gu

export function normalizeChainWord(word: string): ChainHint | undefined {
  const slug = normalizeChainSlug(word)
  return slug && getChain(slug) ? (slug as ChainHint) : undefined
}

export function chainHintFrom(text: string): ChainHint | undefined {
  const onChain = text.match(ON_CHAIN_RE)?.[1]
  if (onChain) return normalizeChainWord(onChain)
  for (const [re, chain] of CHAIN_ALIASES) {
    if (re.test(text)) return chain
  }
  return undefined
}

export function solanaCaFrom(text: string): string | undefined {
  for (const match of text.matchAll(SOLANA_CA)) {
    const candidate = match[1]
    if (candidate && validateAddress("base58-32", candidate)) return candidate
  }
  return undefined
}

export function evmCasFrom(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of text.matchAll(EVM_CA)) {
    const addr = match[1]?.toLowerCase()
    if (addr && !seen.has(addr)) {
      seen.add(addr)
      out.push(addr)
    }
  }
  return out
}

export function allValidCasFrom(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const addr of evmCasFrom(text)) {
    if (!seen.has(addr)) {
      seen.add(addr)
      out.push(addr)
    }
  }
  for (const match of text.matchAll(SOLANA_CA)) {
    const candidate = match[1]
    if (candidate && validateAddress("base58-32", candidate) && !seen.has(candidate)) {
      seen.add(candidate)
      out.push(candidate)
    }
  }
  return out
}

/** Same embed scan as research-candidates CHAIN_CA_IN_TEXT — shared so live-tape stays aligned */
const CHAIN_CA_IN_TEXT = /\b([a-z][a-z0-9-]{1,31}):([A-Za-z0-9]{32,128})\b/giu

export type ChainCaTokenHit = Readonly<{ chainRaw: string; token: string }>

export function chainCaTokensInText(text: string): ChainCaTokenHit[] {
  const out: ChainCaTokenHit[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(CHAIN_CA_IN_TEXT)) {
    const chainRaw = match[1]?.toLowerCase()
    const token = match[2]
    if (!chainRaw || !token) continue
    const key = `${chainRaw}:${token}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ chainRaw, token })
  }
  return out
}

export function stripDiscordFormatting(text: string): string {
  return text
    .replace(/<@!?&?\d+>/gu, " ")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/__([^_]+)__/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim()
}

export { parseChainCa }

import { validateAddress } from "../lib/chains.js"

export const CHAIN_HINT_VALUES = [
  "solana",
  "ethereum",
  "base",
  "bsc",
  "robinhood",
] as const
export type ChainHint = typeof CHAIN_HINT_VALUES[number]

export const CHAIN_ALIASES: ReadonlyArray<[RegExp, ChainHint]> = [
  [/\b(solana|sol)\b/iu, "solana"],
  [/\b(ethereum|eth)\b/iu, "ethereum"],
  [/\b(base)\b/iu, "base"],
  [/\b(bsc|bnb)\b/iu, "bsc"],
  [/\b(robinhood|hood)\b/iu, "robinhood"],
]

export const ON_CHAIN_RE = /\bon\s+(solana|sol|ethereum|eth|base|bsc|bnb|robinhood|hood)\b/iu
export const ALL_CHAIN_WORDS_RE = /\b(solana|sol|ethereum|eth|base|bsc|bnb|robinhood|hood)\b/giu
export const RESEARCH_VERBS =
  /\b(research|deep\s+research|look\s*into|deep[\s-]?dive|investigate|dig\s+into|check\s+out|analyse|analyze)\b/iu
/** Exact chain:CA, optional bot mention / code ticks / leading research verb */
export const CHAIN_CA =
  /^(?:<@!?&?\d+>\s*)?(?:(?:research|deep\s+research|look\s*into|investigate|analyse|analyze|check\s+out|deep[\s-]?dive)\s+)?(?:`)?(solana|ethereum|base|bsc|robinhood):([A-Za-z0-9]{32,128})(?:`)?$/iu
export const EVM_CA = /\b(0x[a-fA-F0-9]{40})\b/gu
export const SOLANA_CA = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/gu

export function normalizeChainWord(word: string): ChainHint | undefined {
  const lower = word.toLowerCase()
  if (lower === "sol" || lower === "solana") return "solana"
  if (lower === "eth" || lower === "ethereum") return "ethereum"
  if (lower === "base") return "base"
  if (lower === "bsc" || lower === "bnb") return "bsc"
  if (lower === "hood" || lower === "robinhood") return "robinhood"
  return undefined
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

export function stripDiscordFormatting(text: string): string {
  return text
    .replace(/<@!?&?\d+>/gu, " ")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/__([^_]+)__/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim()
}

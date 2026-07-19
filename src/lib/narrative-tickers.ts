import type { NarrativeLogEntry } from "../orchestrator/narrative-log.js"

export const MAX_TICKERS_PER_NARRATIVE = 8

export const STOPWORDS = new Set([
  "THE", "AND", "FOR", "WITH", "FROM", "THIS", "THAT", "INTO", "OVER", "UNDER",
  "MEME", "COIN", "TOKEN", "NARRATIVE", "TRENDING", "ROTATION", "ALPHA",
])

/** Chain-native / stable / wrap symbols that must never become research subjects */
export const GENERIC_CHAIN_SYMBOLS = new Set([
  "SOL", "ETH", "BTC", "BNB", "USDC", "USDT", "DAI", "WETH", "WSOL", "WBNB",
  "WBTC", "STETH", "CBETH", "MATIC", "POL", "AVAX", "TRX", "TON", "XRP",
  "DOGE", "ADA", "DOT", "LINK", "UNI", "ARB", "OP", "ATOM", "NEAR", "SUI",
  "APT", "HYPE", "NATIVE",
])

export function isGenericChainSymbol(raw: string): boolean {
  return GENERIC_CHAIN_SYMBOLS.has(raw.trim().replace(/^\$/u, "").toUpperCase())
}

export const GENERIC_CHAIN_SYMBOL_REASON = "generic-chain-symbol"

export function normalizeSymbol(raw: string): string | undefined {
  const symbol = raw.trim().replace(/^\$/u, "").trim()
  if (!/^[A-Za-z][A-Za-z0-9]{1,20}$/u.test(symbol)) return undefined
  const upper = symbol.toUpperCase()
  if (STOPWORDS.has(upper)) return undefined
  if (GENERIC_CHAIN_SYMBOLS.has(upper)) return undefined
  return symbol
}

/**
 * Explicit tickers only: bounded `tickers` fields and cashtags ($TICKER).
 * Never infer bare uppercase/title words from title/slug (those produced SOL noise).
 */
export function extractNarrativeTickers(entry: NarrativeLogEntry): string[] {
  const found = new Map<string, string>()
  const add = (raw: string): void => {
    const symbol = normalizeSymbol(raw)
    if (!symbol) return
    const key = symbol.toLowerCase()
    if (!found.has(key) && found.size < MAX_TICKERS_PER_NARRATIVE) {
      found.set(key, symbol)
    }
  }

  for (const ticker of entry.tickers ?? []) add(ticker)

  const text = `${entry.title} ${entry.slug.replace(/-/gu, " ")}`
  for (const match of text.matchAll(/\$([A-Za-z][A-Za-z0-9]{1,20})\b/gu)) {
    add(match[1] ?? "")
  }
  return [...found.values()]
}

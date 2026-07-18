import type { NarrativeLogEntry } from "../orchestrator/narrative-log.js"

export const MAX_TICKERS_PER_NARRATIVE = 8

export const STOPWORDS = new Set([
  "THE", "AND", "FOR", "WITH", "FROM", "THIS", "THAT", "INTO", "OVER", "UNDER",
  "MEME", "COIN", "TOKEN", "NARRATIVE", "TRENDING", "ROTATION", "ALPHA",
])

export function normalizeSymbol(raw: string): string | undefined {
  const symbol = raw.trim().replace(/^\$/u, "").trim()
  if (!/^[A-Za-z][A-Za-z0-9]{1,20}$/u.test(symbol)) return undefined
  if (STOPWORDS.has(symbol.toUpperCase())) return undefined
  return symbol
}

/** Tickers named explicitly or inferred from a narrative's title and slug. */
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
  for (const match of text.matchAll(/\b([A-Z][A-Z0-9]{2,14})\b/gu)) {
    add(match[1] ?? "")
  }
  for (const match of text.matchAll(/\b([A-Z][a-z]{2,12}[A-Z][A-Za-z0-9]*)\b/gu)) {
    add(match[1] ?? "")
  }
  return [...found.values()]
}

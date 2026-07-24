/**
 * Distinctive tokens used to recognize a narrative in free text.
 * Shared by stage-dedupe and stale-framing detectors.
 */

const STAGE_STOPWORDS = new Set([
  "meme",
  "meta",
  "sol",
  "the",
  "and",
  "for",
  "surge",
  "collapse",
  "trust",
  "bridge",
  "agents",
  "fun",
  "coin",
  "chain",
  "base",
  "token",
  "launch",
])

/** Short tokens allowed as distinctive aliases (operator shorthand). */
const SHORT_ALIAS_ALLOW = new Set(["rh", "pfp"])

export type NarrativeAliasSource = Readonly<{
  slug: string
  title: string
}>

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

export function narrativeAliases(entry: NarrativeAliasSource): string[] {
  const aliases = new Set<string>()
  for (const part of entry.slug.split("-")) {
    if (STAGE_STOPWORDS.has(part)) continue
    if (part.length >= 4 || SHORT_ALIAS_ALLOW.has(part)) aliases.add(part)
  }
  for (const word of entry.title.toLowerCase().split(/[^a-z0-9]+/u)) {
    if (STAGE_STOPWORDS.has(word)) continue
    if (word.length >= 4 || SHORT_ALIAS_ALLOW.has(word)) aliases.add(word)
  }
  // Common operator shorthand for Robinhood-chain narratives
  if (entry.slug.includes("rh-") || /\brobinhood\b/iu.test(entry.title)) {
    aliases.add("rh")
  }
  return [...aliases]
}

export function textMentionsNarrativeAlias(
  text: string,
  entry: NarrativeAliasSource,
): boolean {
  const aliases = narrativeAliases(entry)
  if (aliases.length === 0) return false
  return aliases.some((alias) =>
    new RegExp(`\\b${escapeRegExp(alias)}\\b`, "iu").test(text),
  )
}

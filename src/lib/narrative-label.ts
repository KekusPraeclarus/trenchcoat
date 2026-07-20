/**
 * Human labels for narrative kebab slugs (display only — ids stay kebab).
 * rh-chain-meme-rotation → RH Chain Meme Rotation
 */

/** Tokens rendered fully uppercase when deslugging */
const SLUG_ACRONYMS = new Set([
  "rh",
  "ai",
  "pfp",
  "sol",
  "eth",
  "btc",
  "bnb",
  "bsc",
  "nft",
  "dao",
  "defi",
  "usd",
  "usdc",
  "usdt",
  "op",
  "arb",
])

/** Lowercase multi-segment kebab matching NarrativeLogEntry.slug */
const NARRATIVE_SLUG_IN_TEXT = /\b[a-z0-9]+(?:-[a-z0-9]+){1,}\b/gu

const URL_IN_TEXT = /https?:\/\/[^\s<>\]]+/gu

export function deslugNarrativeLabel(slug: string): string {
  return slug.split("-").filter((part) => part.length > 0).map((part) => {
    const lower = part.toLowerCase()
    if (SLUG_ACRONYMS.has(lower)) return lower.toUpperCase()
    return lower.charAt(0).toUpperCase() + lower.slice(1)
  }).join(" ")
}

/** Replace kebab narrative slugs with title-case labels; leave URLs alone */
export function deslugNarrativeLabelsInText(text: string): string {
  const urls: string[] = []
  const withUrlSlots = text.replace(URL_IN_TEXT, (url) => {
    const i = urls.length
    urls.push(url)
    return `\u0001${i}\u0001`
  })
  const deslugged = withUrlSlots.replace(NARRATIVE_SLUG_IN_TEXT, (match) =>
    deslugNarrativeLabel(match),
  )
  return deslugged.replace(/\u0001(\d+)\u0001/gu, (_m, i: string) => urls[Number(i)] ?? "")
}

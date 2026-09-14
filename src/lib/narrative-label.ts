/**
 * Human labels for narrative kebab slugs (display only — ids stay kebab).
 * rh-chain-meme-rotation → RH Chain Meme Rotation
 */

import { textMentionsNarrativeAlias } from "./narrative-aliases.js"
import {
  effectiveFraming,
  isMatureFraming,
  type NarrativeFraming,
} from "./narrative-framing.js"

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

const ROTATION_WORD = /\brotation\b/iu

export function deslugNarrativeLabel(slug: string): string {
  return slug.split("-").filter((part) => part.length > 0).map((part) => {
    const lower = part.toLowerCase()
    if (SLUG_ACRONYMS.has(lower)) return lower.toUpperCase()
    return lower.charAt(0).toUpperCase() + lower.slice(1)
  }).join(" ")
}

const CODE_SPAN_IN_TEXT = /`[^`\n]+`/gu
const REMEDIATION_ID_IN_TEXT = /\brem-[a-z0-9]{3,64}\b/gu
const TRENCHCOAT_UNIT_IN_TEXT = /\btrenchcoat(?:-[a-z0-9]+)+\b/gu

/** Replace kebab narrative slugs with title-case labels. Keep URLs, code, rem ids, and units. */
export function deslugNarrativeLabelsInText(text: string): string {
  const slots: string[] = []
  const park = (value: string): string => {
    const i = slots.length
    slots.push(value)
    return `\u0001${i}\u0001`
  }
  const parked = text
    .replace(URL_IN_TEXT, park)
    .replace(CODE_SPAN_IN_TEXT, park)
    .replace(REMEDIATION_ID_IN_TEXT, park)
    .replace(TRENCHCOAT_UNIT_IN_TEXT, park)
  const deslugged = parked.replace(NARRATIVE_SLUG_IN_TEXT, (match) =>
    deslugNarrativeLabel(match),
  )
  return deslugged.replace(/\u0001(\d+)\u0001/gu, (_m, i: string) => slots[Number(i)] ?? "")
}

export type NarrativeLabelSource = Readonly<{
  slug: string
  title?: string | undefined
  framing?: NarrativeFraming | undefined
}>

export function preferredNarrativeLabel(source: NarrativeLabelSource): string {
  const title = source.title?.trim() ?? ""
  const framing = effectiveFraming(source)
  if (isMatureFraming(framing) && title.length > 0) return title
  if (
    title.length > 0
    && !ROTATION_WORD.test(title)
    && source.slug.includes("rotation")
  ) {
    return title
  }
  return deslugNarrativeLabel(source.slug)
}

export function usesStaleRotationFraming(
  text: string,
  matured: readonly NarrativeLabelSource[],
): boolean {
  if (!ROTATION_WORD.test(text)) return false
  for (const entry of matured) {
    if (!isMatureFraming(effectiveFraming(entry))) continue
    const title = entry.title?.trim() || deslugNarrativeLabel(entry.slug)
    if (textMentionsNarrativeAlias(text, { slug: entry.slug, title })) return true
    const mechanical = deslugNarrativeLabel(entry.slug)
    if (mechanical.length > 0 && text.toLowerCase().includes(mechanical.toLowerCase())) {
      return true
    }
  }
  return false
}

export function maturedNarrativeLabels(
  entries: readonly NarrativeLabelSource[],
): NarrativeLabelSource[] {
  return entries.filter((entry) => isMatureFraming(effectiveFraming(entry)))
}

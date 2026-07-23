/**
 * Host-side review report bullets — deterministic clip of sealed agent.md so
 * the review session can skim without loading every body (token-burn).
 */

const PROVENANCE_HANDLE = /(?:twitter|farcaster):@[\w.-]+/giu
/** Bare @handle — excludes twitter:@ / farcaster:@ (colon precedes @) */
const BARE_AT_HANDLE = /(?<![a-z:])@[\w.-]+/giu
const HEADING_H2 = /^##\s+(.+)$/mu

function clipChars(text: string, max: number): string {
  if ([...text].length <= max) return text
  return [...text].slice(0, max).join("")
}

function stripHandles(text: string): string {
  return text
    .replace(PROVENANCE_HANDLE, "")
    .replace(BARE_AT_HANDLE, "")
    .replace(/\(\s*\)/gu, "")
    .replace(/\s{2,}/gu, " ")
}

/**
 * First ## heading text, else first non-empty paragraph. Collapse whitespace,
 * strip @handles, clip to 280 chars.
 */
export function summarizeAgentMd(text: string): string {
  const cleaned = text.replace(/\u0000/gu, "").replace(/\r\n/gu, "\n")
  const heading = HEADING_H2.exec(cleaned)
  let raw: string
  if (heading?.[1]) {
    raw = heading[1]
  } else {
    const paragraphs = cleaned
      .split(/\n\s*\n/u)
      .map((block) => block.trim())
      .filter((block) => block.length > 0)
    raw = paragraphs[0] ?? ""
    // Drop a lone # title line so the bullet is the body when present
    if (/^#\s+\S/u.test(raw) && !raw.includes("\n") && paragraphs.length > 1) {
      raw = paragraphs[1]!
    }
    raw = raw.replace(/^#{1,6}\s+/u, "")
  }
  const collapsed = stripHandles(raw).replace(/\s+/gu, " ").trim()
  return clipChars(collapsed, 280)
}

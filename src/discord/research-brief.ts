export const RESEARCH_BRIEF_MAX = 1200

const SECTION_HEADING = /^##\s+(.+?)\s*$/mu

function collapseWhitespace(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
}

function sectionBody(reportText: string, heading: string): string | undefined {
  const re = new RegExp(`^##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "imu")
  const match = reportText.match(re)
  return match?.[1]?.trim()
}

function skipTitleLines(lines: readonly string[]): number {
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!.trim()
    if (!line) {
      i += 1
      continue
    }
    if (/research$/iu.test(line) || /^[*_]*\s*\$?[A-Za-z0-9]+\s+research\s*[*_]*$/iu.test(line)) {
      i += 1
      continue
    }
    break
  }
  return i
}

export function extractResearchBrief(reportText: string): string {
  const normalized = reportText.replace(/\r\n/g, "\n").trim()
  if (!normalized) return ""

  const tldr = sectionBody(normalized, "TL;DR")
    ?? sectionBody(normalized, "TLDR")
    ?? sectionBody(normalized, "Tl;dr")

  let body: string
  if (tldr) {
    const read = sectionBody(normalized, "Read")
    body = read && tldr.length < 500 ? `${tldr}\n\n${read}` : tldr
  } else {
    const lines = normalized.split("\n")
    const start = skipTitleLines(lines)
    body = lines.slice(start).join("\n").trim()
    if (!body) body = normalized
  }

  body = collapseWhitespace(body)
  if (body.length <= RESEARCH_BRIEF_MAX) return body
  return `${body.slice(0, RESEARCH_BRIEF_MAX - 1)}…`
}

export function parseReportSections(reportText: string): readonly string[] {
  const headings: string[] = []
  for (const match of reportText.matchAll(SECTION_HEADING)) {
    headings.push(match[1]!.trim())
  }
  return headings
}

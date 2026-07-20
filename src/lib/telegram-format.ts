/**
 * Telegram outbound: strip workspace paths, deslug narrative labels, then map a
 * safe markdown subset to Telegram HTML. Used for operator DMs and router fanout.
 */

import { deslugNarrativeLabelsInText } from "./narrative-label.js"
import { scrubLeakedHourHorizons } from "./watch-window.js"

const WORKSPACE_PATH_RE =
  /\b(?:reports|inbox|state|archive|agent|outbox)\/[A-Za-z0-9][A-Za-z0-9._/-]*/gu
const TRENCHCOAT_HOME_RE =
  /(?:~|\/(?:Users|home)\/[^/\s]+)\/\.trenchcoat\/[A-Za-z0-9._/-]+/gu
const ARTIFACT_BASENAME_RE =
  /\b(?:decision-proposals|chat-summary|web-search-requests|agent-pass1|alpha-digest|x-engagement|fc-engagement|narrative-proposals)\.(?:json|md|jsonl)\b/gu

/** True when text still contains workspace paths or known artifact filenames */
export function hasLocalWorkspaceRefs(text: string): boolean {
  WORKSPACE_PATH_RE.lastIndex = 0
  TRENCHCOAT_HOME_RE.lastIndex = 0
  ARTIFACT_BASENAME_RE.lastIndex = 0
  return (
    WORKSPACE_PATH_RE.test(text)
    || TRENCHCOAT_HOME_RE.test(text)
    || ARTIFACT_BASENAME_RE.test(text)
  )
}

/** Remove host/workspace paths and known artifact filenames from operator-facing text */
export function stripLocalWorkspaceRefs(text: string): string {
  let out = text.replace(/\u0000/gu, "")
  out = out.replace(TRENCHCOAT_HOME_RE, "")
  out = out.replace(WORKSPACE_PATH_RE, "")
  out = out.replace(ARTIFACT_BASENAME_RE, "")
  out = out.replace(/^Source:\s*$/gmu, "")
  out = out.replace(/^Source:\s*[.:\-–—]*\s*$/gmu, "")
  out = out.replace(/\b(?:in|at|see|via|under)\s+[.:\-–—]+\s*/gu, "")
  out = out.replace(/\b(?:in|at|see|via|under)\s+\./gu, ".")
  out = out.replace(/[ \t]+\n/gu, "\n")
  out = out.replace(/\n{3,}/gu, "\n\n")
  out = out.replace(/[ \t]{2,}/gu, " ")
  return out.trim()
}

export function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
}

function formatInlineMarkdown(line: string): string {
  const codes: string[] = []
  const withCodeSlots = line.replace(/`([^`\n]+)`/gu, (_m, code: string) => {
    const i = codes.length
    codes.push(`<code>${escapeTelegramHtml(code)}</code>`)
    return `\u0000${i}\u0000`
  })
  let escaped = escapeTelegramHtml(withCodeSlots)
  escaped = escaped.replace(/\*\*(.+?)\*\*/gu, "<b>$1</b>")
  escaped = escaped.replace(/__(.+?)__/gu, "<b>$1</b>")
  return escaped.replace(/\u0000(\d+)\u0000/gu, (_m, i: string) => codes[Number(i)] ?? "")
}

/**
 * Convert a small markdown subset to Telegram HTML. Unknown markup is escaped,
 * never passed through as raw HTML.
 */
export function markdownToTelegramHtml(text: string): string {
  return text.split("\n").map((line) => {
    const header = /^(#{1,3})\s+(.+)$/u.exec(line)
    if (header?.[2]) return `<b>${formatInlineMarkdown(header[2])}</b>`
    return formatInlineMarkdown(line)
  }).join("\n")
}

/** Strip refs, scrub leaked hour tokens, deslug narrative labels, markdown → HTML */
export function formatTelegramOperatorText(text: string): string {
  return markdownToTelegramHtml(
    deslugNarrativeLabelsInText(
      scrubLeakedHourHorizons(stripLocalWorkspaceRefs(text)),
    ),
  )
}

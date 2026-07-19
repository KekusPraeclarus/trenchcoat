import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import {
  splitTelegramText,
  TELEGRAM_LONG_REPORT_CHARS,
  TELEGRAM_SAFE_CHUNK,
} from "../lib/telegram-bot.js"

export type PreparedTelegramReply = Readonly<{
  parts: readonly string[]
  persistedPath?: string
}>

/**
 * Never truncate. Chunk at paragraph boundaries; for very long replies persist
 * the full text under reports/chat/ and send a summary that points at it.
 */
export async function prepareTelegramReply(args: Readonly<{
  text: string
  agentRoot?: string
  nowIso?: string
  chunkLimit?: number
  longReportChars?: number
}>): Promise<PreparedTelegramReply> {
  const trimmed = args.text.trim()
  const chunkLimit = args.chunkLimit ?? TELEGRAM_SAFE_CHUNK
  const longReportChars = args.longReportChars ?? TELEGRAM_LONG_REPORT_CHARS

  if (
    args.agentRoot
    && trimmed.length > longReportChars
  ) {
    const stamp = (args.nowIso ?? new Date().toISOString())
      .replace(/[:.]/gu, "")
      .replace(/Z$/u, "Z")
    const rel = `reports/chat/chat-${stamp}.md`
    const abs = join(args.agentRoot, "reports", "chat", `chat-${stamp}.md`)
    mkdirSync(join(args.agentRoot, "reports", "chat"), { recursive: true, mode: 0o700 })
    await writeAtomicFile(abs, `${trimmed}\n`)

    const summaryBudget = Math.min(1_800, chunkLimit - 120)
    const summaryBody = summarizeForTelegram(trimmed, summaryBudget)
    const notice = `${summaryBody}\n\n(full reply saved on host — ask if you need it)`
    return { parts: splitTelegramText(notice, chunkLimit), persistedPath: rel }
  }

  return { parts: splitTelegramText(trimmed, chunkLimit) }
}

function summarizeForTelegram(text: string, budget: number): string {
  if (text.length <= budget) return text
  const paragraphs = text.split(/\n{2,}/u)
  let out = ""
  for (const para of paragraphs) {
    const next = out.length === 0 ? para : `${out}\n\n${para}`
    if (next.length > budget) break
    out = next
  }
  if (out.length >= Math.floor(budget * 0.4)) return out
  return `${text.slice(0, budget).trimEnd()}…`
}

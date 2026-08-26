/** Thin Bot API client for the operator chat listener (not market collectors). */

import { formatTelegramOperatorText, stripLocalWorkspaceRefs } from "./telegram-format.js"
import { deslugNarrativeLabelsInText } from "./narrative-label.js"
import { scrubWatchProse } from "./watch-window.js"
import { parseDailyDigestUnits } from "../orchestrator/distill-session.js"

export type TelegramBotFetcher = (
  url: string,
  init?: RequestInit,
) => Promise<Response>

/** Soft cap under Telegram's 4096 hard limit; leaves room for part prefixes */
export const TELEGRAM_SAFE_CHUNK = 3_800

/** Persist full text and send a summary when a reply exceeds this */
export const TELEGRAM_LONG_REPORT_CHARS = 7_600

const DIGEST_TITLE_DATE_RE = /^\*\*Daily narrative map — (\d{4}-\d{2}-\d{2})\*\*/u
const DOCUMENT_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

/** Filename for the raw daily digest markdown file. */
export function digestMarkdownFilename(activityLondonDate: string): string {
  const day = /^\d{4}-\d{2}-\d{2}$/u.test(activityLondonDate)
    ? activityLondonDate
    : "unknown"
  return `daily-narrative-map-${day}.md`
}

/** Read the activity date from a host-rendered digest title. */
export function digestMarkdownFilenameFromText(text: string): string {
  const match = text.trim().match(DIGEST_TITLE_DATE_RE)
  return digestMarkdownFilename(match?.[1] ?? "unknown")
}

/** Caption for the raw daily digest markdown file. */
export function digestMarkdownCaptionFromText(text: string): string {
  const match = text.trim().match(DIGEST_TITLE_DATE_RE)
  return match ? `Daily narrative map — ${match[1]}` : "Daily narrative map"
}

async function callBot(
  fetcher: TelegramBotFetcher,
  token: string,
  method: string,
  body: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<void> {
  const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    const err = new Error(
      `telegram ${method} HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    ) as Error & { retryable?: boolean; retryAfterSeconds?: number }
    err.retryable = response.status === 429 || response.status >= 500
    const ra = response.headers.get("retry-after")
    if (ra) err.retryAfterSeconds = Number(ra)
    throw err
  }
}

export async function telegramSendMessage(
  fetcher: TelegramBotFetcher,
  token: string,
  chatId: string,
  text: string,
  opts?: Readonly<{ parseMode?: "HTML"; replyToMessageId?: string }>,
): Promise<{ messageId?: string }> {
  const response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(opts?.parseMode ? { parse_mode: opts.parseMode } : {}),
      ...(opts?.replyToMessageId
        ? { reply_to_message_id: Number(opts.replyToMessageId) }
        : {}),
    }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    const err = new Error(
      `telegram sendMessage HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    ) as Error & { retryable?: boolean; retryAfterSeconds?: number }
    err.retryable = response.status === 429 || response.status >= 500
    const ra = response.headers.get("retry-after")
    if (ra) err.retryAfterSeconds = Number(ra)
    throw err
  }
  try {
    const body = await response.json() as { result?: { message_id?: number } }
    const id = body.result?.message_id
    return typeof id === "number" ? { messageId: String(id) } : {}
  } catch {
    return {}
  }
}

/**
 * Operator DMs: strip workspace paths, convert markdown → HTML, fall back to
 * plain stripped text if Telegram rejects the markup.
 */
export async function telegramSendOperatorMessage(
  fetcher: TelegramBotFetcher,
  token: string,
  chatId: string,
  text: string,
): Promise<{ messageId?: string }> {
  const html = formatTelegramOperatorText(text)
  try {
    return await telegramSendMessage(fetcher, token, chatId, html, { parseMode: "HTML" })
  } catch {
    return telegramSendMessage(
      fetcher,
      token,
      chatId,
      deslugNarrativeLabelsInText(
        scrubWatchProse(stripLocalWorkspaceRefs(text)),
      ),
    )
  }
}

/** Send one Telegram message per chunk; never truncates. */
export async function telegramSendMessageChunks(
  fetcher: TelegramBotFetcher,
  token: string,
  chatId: string,
  text: string,
  limit = TELEGRAM_SAFE_CHUNK,
): Promise<number> {
  const parts = splitTelegramText(text, limit)
  for (const part of parts) {
    await telegramSendMessage(fetcher, token, chatId, part)
  }
  return parts.length
}

/**
 * Strip refs, chunk markdown, send HTML with plain fallback per part.
 * Shared by operator DMs and router channel fanout.
 */
export async function telegramSendFormattedChunks(
  fetcher: TelegramBotFetcher,
  token: string,
  chatId: string,
  text: string,
  limit = TELEGRAM_SAFE_CHUNK,
  opts?: Readonly<{ numbered?: boolean }>,
): Promise<{ parts: number; messageIds: string[] }> {
  const mdLimit = Math.max(64, Math.min(limit, TELEGRAM_SAFE_CHUNK) - 400)
  const parts = splitTelegramText(stripLocalWorkspaceRefs(text), mdLimit, opts)
  const messageIds: string[] = []
  for (const part of parts) {
    const result = await telegramSendOperatorMessage(fetcher, token, chatId, part)
    if (result.messageId) messageIds.push(result.messageId)
  }
  return { parts: parts.length, messageIds }
}

/** Send a raw file. Never truncates the bytes. */
export async function telegramSendDocument(
  fetcher: TelegramBotFetcher,
  token: string,
  chatId: string,
  args: Readonly<{
    filename: string
    bytes: string
    caption?: string
    contentType?: string
  }>,
): Promise<{ messageId?: string }> {
  if (!DOCUMENT_FILENAME_RE.test(args.filename)) {
    throw new TypeError("telegram document filename is invalid")
  }
  const blob = new Blob([args.bytes], {
    type: args.contentType ?? "text/markdown; charset=utf-8",
  })
  const form = new FormData()
  form.append("chat_id", chatId)
  form.append("document", blob, args.filename)
  if (args.caption && args.caption.trim().length > 0) {
    form.append("caption", args.caption.trim().slice(0, 1024))
  }
  const response = await fetcher(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: "POST",
    body: form,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    const err = new Error(
      `telegram sendDocument HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    ) as Error & { retryable?: boolean; retryAfterSeconds?: number }
    err.retryable = response.status === 429 || response.status >= 500
    const ra = response.headers.get("retry-after")
    if (ra) err.retryAfterSeconds = Number(ra)
    throw err
  }
  try {
    const body = await response.json() as { result?: { message_id?: number } }
    const id = body.result?.message_id
    return typeof id === "number" ? { messageId: String(id) } : {}
  } catch {
    return {}
  }
}

/** Daily digest fanout: section-aware chunks, no page labels. */
export async function telegramSendDailyDigestChunks(
  fetcher: TelegramBotFetcher,
  token: string,
  chatId: string,
  text: string,
  limit = TELEGRAM_SAFE_CHUNK,
): Promise<{ parts: number; messageIds: string[] }> {
  const mdLimit = Math.max(64, Math.min(limit, TELEGRAM_SAFE_CHUNK) - 400)
  const parts = splitDailyDigestTelegramText(stripLocalWorkspaceRefs(text), mdLimit)
  const messageIds: string[] = []
  for (const part of parts) {
    const result = await telegramSendOperatorMessage(fetcher, token, chatId, part)
    if (result.messageId) messageIds.push(result.messageId)
  }
  return { parts: parts.length, messageIds }
}

/** Operator DMs with path strip + HTML; chunks markdown before conversion */
export async function telegramSendOperatorMessageChunks(
  fetcher: TelegramBotFetcher,
  token: string,
  chatId: string,
  text: string,
  limit = TELEGRAM_SAFE_CHUNK,
): Promise<number> {
  const result = await telegramSendFormattedChunks(fetcher, token, chatId, text, limit)
  return result.parts
}

/**
 * Split text into Telegram-safe chunks at paragraph boundaries.
 * Numbered `1/n` … when more than one part (unless `numbered: false`).
 * Prefers not to break fenced code blocks; falls back to hard splits when a
 * single block exceeds the limit.
 */
export function splitTelegramText(
  text: string,
  limit = TELEGRAM_SAFE_CHUNK,
  opts?: Readonly<{ numbered?: boolean }>,
): string[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return [""]
  if (!Number.isSafeInteger(limit) || limit < 64) {
    throw new TypeError("telegram chunk limit must be an integer >= 64")
  }
  if (trimmed.length <= limit) return [trimmed]

  const numbered = opts?.numbered !== false
  const prefixBudget = (total: number, index: number): number => {
    if (!numbered || total <= 1) return 0
    return `${index + 1}/${total}\n`.length
  }

  const units = splitPreserveCodeFences(trimmed)
  const packed = packUnits(units, limit, prefixBudget)
  if (packed.length <= 1 || !numbered) return packed

  return packed.map((body, index) => `${index + 1}/${packed.length}\n${body}`)
}

/** Pack a daily digest across Telegram messages without splitting sections. */
export function splitDailyDigestTelegramText(
  text: string,
  limit = TELEGRAM_SAFE_CHUNK,
): string[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return [""]
  if (!Number.isSafeInteger(limit) || limit < 64) {
    throw new TypeError("telegram chunk limit must be an integer >= 64")
  }
  if (trimmed.length <= limit) return [trimmed]

  const units = parseDailyDigestUnits(trimmed)
  if (units.length === 0) {
    return splitTelegramText(trimmed, limit, { numbered: false })
  }
  return packUnits(units, limit, () => 0)
}

function fenceToggles(para: string): number {
  let n = 0
  for (const line of para.split("\n")) {
    if (line.startsWith("```")) n += 1
  }
  return n
}

function splitPreserveCodeFences(text: string): string[] {
  const units: string[] = []
  const paragraphs = text.split(/\n{2,}/u)
  let fenceBuf: string[] = []
  let inFence = false

  const flushFence = (): void => {
    if (fenceBuf.length === 0) return
    units.push(fenceBuf.join("\n\n"))
    fenceBuf = []
  }

  for (const para of paragraphs) {
    const odd = fenceToggles(para) % 2 === 1
    if (inFence) {
      fenceBuf.push(para)
      if (odd) {
        inFence = false
        flushFence()
      }
      continue
    }
    if (odd) {
      inFence = true
      fenceBuf = [para]
      continue
    }
    units.push(para)
  }
  flushFence()
  return units.filter((u) => u.length > 0)
}

function packUnits(
  units: readonly string[],
  limit: number,
  prefixBudget: (total: number, index: number) => number,
): string[] {
  // First pack assuming multi-part prefixes; re-pack if part count changes prefix size
  let parts = packWithAssumedTotal(units, limit, 9)
  for (let i = 0; i < 3; i += 1) {
    const next = packWithAssumedTotal(units, limit, parts.length)
    if (next.length === parts.length) {
      // Verify each part fits with its real prefix
      const ok = next.every((body, index) => (
        body.length + prefixBudget(next.length, index) <= limit
      ))
      if (ok) return next
    }
    parts = next
  }
  return parts
}

function packWithAssumedTotal(
  units: readonly string[],
  limit: number,
  assumedTotal: number,
): string[] {
  const prefixLen = assumedTotal <= 1 ? 0 : `${assumedTotal}/${assumedTotal}\n`.length
  const bodyLimit = Math.max(32, limit - prefixLen)
  const parts: string[] = []
  let current = ""

  const pushCurrent = (): void => {
    if (current.length === 0) return
    parts.push(current)
    current = ""
  }

  for (const unit of units) {
    if (unit.length > bodyLimit) {
      pushCurrent()
      for (const piece of hardSplit(unit, bodyLimit)) {
        parts.push(piece)
      }
      continue
    }
    const candidate = current.length === 0 ? unit : `${current}\n\n${unit}`
    if (candidate.length <= bodyLimit) {
      current = candidate
      continue
    }
    pushCurrent()
    current = unit
  }
  pushCurrent()
  return parts.length > 0 ? parts : [""]
}

function hardSplit(text: string, limit: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit)
    if (cut < Math.floor(limit * 0.5)) cut = rest.lastIndexOf(" ", limit)
    if (cut < Math.floor(limit * 0.5)) cut = limit
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest.length > 0) out.push(rest)
  return out
}

/** Ephemeral streaming preview (Bot API 9.5+). Final text still needs sendMessage. */
export async function telegramSendMessageDraft(
  fetcher: TelegramBotFetcher,
  token: string,
  chatId: string,
  draftId: number,
  text: string,
): Promise<void> {
  await callBot(fetcher, token, "sendMessageDraft", {
    chat_id: Number(chatId),
    draft_id: draftId,
    text,
  }, 15_000)
}

export async function telegramSendChatAction(
  fetcher: TelegramBotFetcher,
  token: string,
  chatId: string,
  action: "typing" = "typing",
): Promise<void> {
  await callBot(fetcher, token, "sendChatAction", {
    chat_id: chatId,
    action,
  }, 10_000)
}

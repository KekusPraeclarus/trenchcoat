/** Thin Bot API client for the operator chat listener (not market collectors). */

import { formatTelegramOperatorText, stripLocalWorkspaceRefs } from "./telegram-format.js"

export type TelegramBotFetcher = (
  url: string,
  init?: RequestInit,
) => Promise<Response>

/** Soft cap under Telegram's 4096 hard limit; leaves room for part prefixes */
export const TELEGRAM_SAFE_CHUNK = 3_800

/** Persist full text and send a summary when a reply exceeds this */
export const TELEGRAM_LONG_REPORT_CHARS = 7_600

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
    throw new Error(`telegram ${method} HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`)
  }
}

export async function telegramSendMessage(
  fetcher: TelegramBotFetcher,
  token: string,
  chatId: string,
  text: string,
  opts?: Readonly<{ parseMode?: "HTML" }>,
): Promise<void> {
  await callBot(fetcher, token, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(opts?.parseMode ? { parse_mode: opts.parseMode } : {}),
  })
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
): Promise<void> {
  const html = formatTelegramOperatorText(text)
  try {
    await telegramSendMessage(fetcher, token, chatId, html, { parseMode: "HTML" })
  } catch {
    await telegramSendMessage(fetcher, token, chatId, stripLocalWorkspaceRefs(text))
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

/** Operator DMs with path strip + HTML; chunks markdown before conversion */
export async function telegramSendOperatorMessageChunks(
  fetcher: TelegramBotFetcher,
  token: string,
  chatId: string,
  text: string,
  limit = TELEGRAM_SAFE_CHUNK,
): Promise<number> {
  // Leave headroom for HTML tags after conversion
  const mdLimit = Math.max(64, Math.min(limit, TELEGRAM_SAFE_CHUNK - 400))
  const parts = splitTelegramText(stripLocalWorkspaceRefs(text), mdLimit)
  for (const part of parts) {
    await telegramSendOperatorMessage(fetcher, token, chatId, part)
  }
  return parts.length
}

/**
 * Split text into Telegram-safe chunks at paragraph boundaries.
 * Numbered `1/n` … when more than one part. Prefers not to break fenced
 * code blocks; falls back to hard splits when a single block exceeds the limit.
 */
export function splitTelegramText(
  text: string,
  limit = TELEGRAM_SAFE_CHUNK,
): string[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return [""]
  if (!Number.isSafeInteger(limit) || limit < 64) {
    throw new TypeError("telegram chunk limit must be an integer >= 64")
  }
  if (trimmed.length <= limit) return [trimmed]

  const prefixBudget = (total: number, index: number): number => {
    if (total <= 1) return 0
    return `${index + 1}/${total}\n`.length
  }

  const units = splitPreserveCodeFences(trimmed)
  const packed = packUnits(units, limit, prefixBudget)
  if (packed.length <= 1) return packed

  return packed.map((body, index) => `${index + 1}/${packed.length}\n${body}`)
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

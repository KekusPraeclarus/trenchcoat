import { open, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"
import { gatedFetch } from "../../lib/http.js"
import { assertPathInside, sanitizePathSegment } from "../../lib/snapshot.js"
import { sha256Bytes } from "../../lib/fs-atomic.js"
import type { FetchLike } from "../market/geckoterminal.js"

export type TelegramPreviewMessage = Readonly<{
  id: string
  channel: string
  text: string
  timestamp: string
  url: string
  provenance: string
}>

export function parseTelegramPreview(html: string, channel: string): TelegramPreviewMessage[] {
  const safeChannel = sanitizePathSegment(channel)
  const blocks = html.match(/<div class="tgme_widget_message_wrap[^"]*"[\s\S]*?<\/div>\s*<\/div>/gu) ?? []
  const messages = blocks.flatMap((block) => {
    const id = block.match(/data-post="[^/]+\/(\d+)"/u)?.[1]
    const timestamp = block.match(/<time[^>]+datetime="([^"]+)"/u)?.[1]
    const text = block.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/u)?.[1]
      ?.replace(/<br\s*\/?>/gu, "\n")
      .replace(/<[^>]*>/gu, "")
      .replace(/&amp;/gu, "&")
      .replace(/&lt;/gu, "<")
      .replace(/&gt;/gu, ">")
      .trim()
    if (!id || !timestamp || !text || text.length > 20_000) return []
    return [{ id, channel: safeChannel, text, timestamp, url: `https://t.me/${safeChannel}/${id}`, provenance: `telegram:${safeChannel}` }]
  })
  return [...new Map(messages.map((message) => [message.id, message])).values()]
}

export async function fetchTelegramPreview(fetcher: FetchLike, channel: string, before?: string): Promise<TelegramPreviewMessage[]> {
  const safeChannel = sanitizePathSegment(channel)
  if (before !== undefined) sanitizePathSegment(before)
  const url = new URL(`https://t.me/s/${safeChannel}`)
  if (before !== undefined) url.searchParams.set("before", before)
  const response = await gatedFetch(fetcher, url, { host: "t.me", capacity: 20, refillPerSecond: 20 / 60, maxBytes: 2 * 1024 * 1024 })
  if (!response.ok) throw new Error(`Telegram preview request failed with HTTP ${response.status}`)
  const html = await response.text()
  if (Buffer.byteLength(html) > 2 * 1024 * 1024) throw new RangeError("Telegram preview exceeds size limit")
  return parseTelegramPreview(html, safeChannel)
}

export async function writeTelegramQueueMessage(
  agentRoot: string,
  message: TelegramPreviewMessage,
): Promise<Readonly<{ path: string; hash: `sha256:${string}`; written: boolean }>> {
  const channel = sanitizePathSegment(message.channel)
  const id = sanitizePathSegment(message.id)
  const directory = assertPathInside(agentRoot, join(agentRoot, "alpha-queue", channel))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = assertPathInside(directory, join(directory, `${id}.json`))
  const body = `${JSON.stringify({
    source: "telegram.preview",
    fetchedAt: new Date().toISOString(),
    trust: "untrusted-external",
    items: [{ provenance: message.provenance, text: message.text, url: message.url, ts: message.timestamp, ageSec: 0, freshnessTier: "live" }],
  }, null, 2)}\n`
  const hash = sha256Bytes(body)
  const tmp = join(dirname(path), `.${randomBytes(8).toString("hex")}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(tmp, "wx", 0o600)
    await handle.writeFile(body)
    await handle.sync()
    await handle.close()
    handle = undefined
    try {
      await import("node:fs/promises").then(({ link }) => link(tmp, path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return { path, hash, written: false }
      throw error
    }
    await import("node:fs/promises").then(({ unlink }) => unlink(tmp))
    return { path, hash, written: true }
  } finally {
    await handle?.close()
    await import("node:fs/promises").then(({ unlink }) => unlink(tmp).catch(() => undefined))
  }
}

export function floodWaitMilliseconds(error: unknown): number | undefined {
  const seconds = typeof error === "object" && error !== null && "seconds" in error && typeof error.seconds === "number"
    ? error.seconds
    : typeof error === "object" && error !== null && "errorMessage" in error && typeof error.errorMessage === "string"
      ? Number(error.errorMessage.match(/FLOOD_WAIT_(\d+)/u)?.[1])
      : undefined
  return seconds !== undefined && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined
}

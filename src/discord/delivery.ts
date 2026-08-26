import { systemClock } from "../lib/clock.js"
import { WorkspaceLock } from "../lib/lock.js"
import { loadConfig } from "../lib/config.js"
import type { DiscordRestClient } from "./bot-client.js"
import {
  chunkDiscordReply,
  partDeliveryKey,
  sanitizeTerminalError,
} from "./render.js"
import type { DiscordStore } from "./store.js"
import type { DiscordRequestRecord } from "./schemas.js"

export const DISCORD_ERRORS = {
  MULTI_NETWORK: "Multiple networks found. Resend as chain:address.",
  NO_MARKET: "No supported market found for that contract.",
  FAILED: "Research failed. Please try again later.",
  BUSY: "Bot is busy. Try again in a moment.",
  WATCH_CAPACITY: "Watchlist capacity reached; this token was not added.",
} as const

async function withStoreLockRetry<T>(
  lockPath: string,
  fn: () => Promise<T>,
  attempts = 40,
): Promise<{ ok: true; value: T } | { ok: false }> {
  for (let i = 0; i < attempts; i += 1) {
    const lock = new WorkspaceLock(lockPath)
    if (lock.tryAcquire()) {
      try {
        return { ok: true, value: await fn() }
      } finally {
        lock.release()
      }
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  return { ok: false }
}

async function persistRequestUpdate(
  store: DiscordStore,
  requestId: string,
  patch: (current: DiscordRequestRecord) => DiscordRequestRecord,
): Promise<boolean> {
  const locked = await withStoreLockRetry(store.layout.lock, async () => {
    const nowIso = systemClock.nowIso()
    let file = store.loadRequests()
    const idx = file.requests.findIndex((r) => r.requestId === requestId)
    if (idx < 0) return false
    file.requests[idx] = patch(file.requests[idx]!)
    await store.saveRequests(file)
    return true
  })
  return locked.ok && locked.value
}

export async function deliverResearchReply(args: Readonly<{
  client: DiscordRestClient
  store: DiscordStore
  request: DiscordRequestRecord
  text: string
  extraParagraph?: string
}>): Promise<{ ok: true } | { ok: false; error: string }> {
  const body = args.extraParagraph
    ? `${args.text}\n\n${args.extraParagraph}`
    : args.text
  const parts = chunkDiscordReply(body)
  const delivered = new Set(args.request.deliveredPartKeys)

  for (let i = 0; i < parts.length; i += 1) {
    const content = parts[i]!
    const key = partDeliveryKey(args.request.messageId, i, content)
    if (delivered.has(key)) continue
    try {
      await args.client.sendReply({
        channelId: args.request.channelId,
        content,
        replyToMessageId: args.request.trackingPingMessageId ?? args.request.messageId,
      })
      delivered.add(key)
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "delivery failed",
      }
    }
  }

  const persisted = await persistRequestUpdate(
    args.store,
    args.request.requestId,
    (current) => ({
      ...current,
      deliveredPartKeys: [...delivered],
      updatedAt: systemClock.nowIso(),
      status: "completed",
    }),
  )
  if (!persisted) {
    return { ok: false, error: "delivery persist failed" }
  }
  return { ok: true }
}

export async function deliverTerminalError(args: Readonly<{
  client: DiscordRestClient
  store: DiscordStore
  request: DiscordRequestRecord
  error: string
}>): Promise<void> {
  const content = sanitizeTerminalError(args.error)
  try {
    await args.client.sendReply({
      channelId: args.request.channelId,
      content,
      replyToMessageId: args.request.messageId,
    })
  } catch {
    // best effort
  }
  await persistRequestUpdate(
    args.store,
    args.request.requestId,
    (current) => ({
      ...current,
      status: "failed",
      terminalError: content,
      updatedAt: systemClock.nowIso(),
    }),
  )
}

export async function deliverRenewalAck(args: Readonly<{
  client: DiscordRestClient
  channelId: string
  messageId: string
}>): Promise<void> {
  await args.client.sendReply({
    channelId: args.channelId,
    content: "Watch renewed for 30 days.",
    replyToMessageId: args.messageId,
  })
}

export function mapResearchError(error?: string): string {
  if (!error) return DISCORD_ERRORS.FAILED
  if (error.includes("Multiple networks")) return DISCORD_ERRORS.MULTI_NETWORK
  if (error.includes("No supported market")) return DISCORD_ERRORS.NO_MARKET
  if (error.includes("ambiguous")) return DISCORD_ERRORS.MULTI_NETWORK
  return sanitizeTerminalError(error)
}

export async function withDiscordLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
): Promise<T | { locked: true }> {
  const lock = new WorkspaceLock(lockPath)
  if (!lock.tryAcquire()) return { locked: true }
  try {
    return await fn()
  } finally {
    lock.release()
  }
}

export function discordConfigReady(): boolean {
  const config = loadConfig()
  return config.chat.discord.enabled
    && Boolean(config.chat.discord.guild_id)
    && config.chat.discord.channel_ids.length > 0
}

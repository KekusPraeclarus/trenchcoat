import { loadConfig } from "../lib/config.js"
import { systemClock } from "../lib/clock.js"
import { WorkspaceLock } from "../lib/lock.js"
import { log } from "../lib/log.js"
import {
  createDiscordRestClient,
  type DiscordRestClient,
} from "./bot-client.js"
import { discordLayout } from "./paths.js"
import { createDiscordStore, type DiscordStore } from "./store.js"
import {
  applyWatchExpiryNoticeSent,
  planWatchExpiryNotices,
  pruneExpiredWatchlist,
  renderWatchExpiryNotice,
  watchExpiryReplyWindowMs,
} from "./watchlist.js"

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

export async function runWatchExpirySweep(args: Readonly<{
  token: string
  client?: DiscordRestClient
  store?: DiscordStore
  nowIso?: string
}>): Promise<number> {
  const config = loadConfig()
  if (!config.chat.discord.enabled) return 0

  const layout = discordLayout()
  const store = args.store ?? createDiscordStore(layout)
  const client = args.client ?? createDiscordRestClient(args.token)
  const nowIso = args.nowIso ?? systemClock.nowIso()
  const replyWindowMs = watchExpiryReplyWindowMs(config)

  const prepared = await withStoreLockRetry(layout.lock, async () => {
    let file = pruneExpiredWatchlist(store.loadWatchlist(), nowIso, replyWindowMs)
    await store.saveWatchlist(file)
    return planWatchExpiryNotices({ file, nowIso, replyWindowMs })
  })
  if (!prepared.ok) return 0

  let sent = 0
  for (const plan of prepared.value) {
    const content = renderWatchExpiryNotice({
      userId: plan.userId,
      labels: plan.labels,
    })
    try {
      const result = await client.sendChannelMessage({
        channelId: plan.channelId,
        content,
        mentionUserIds: [plan.userId],
      })
      const saved = await withStoreLockRetry(layout.lock, async () => {
        const file = store.loadWatchlist()
        const next = applyWatchExpiryNoticeSent({
          file,
          plan,
          noticeMessageId: result.messageId,
          nowIso,
        })
        await store.saveWatchlist(next)
      })
      if (saved.ok) sent += 1
    } catch (error) {
      log.warn("discord watch expiry notice failed", {
        userId: plan.userId,
        error: error instanceof Error ? error.message : "unknown",
      })
    }
  }

  await withStoreLockRetry(layout.lock, async () => {
    const file = pruneExpiredWatchlist(store.loadWatchlist(), nowIso, replyWindowMs)
    await store.saveWatchlist(file)
  })

  return sent
}

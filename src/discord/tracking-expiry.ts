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
  applyExpiryNoticeSent,
  flipElapsedAwaitingReply,
  planExpiryNotices,
  pruneTrackingFile,
  type TrackingConfigSlice,
} from "./tracking-state.js"
import { renderExpiryNotice } from "./tracking-sanitize.js"

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

function trackingConfigSlice(): TrackingConfigSlice {
  const cfg = loadConfig().chat.discord.tracking
  return {
    max_active_per_user: cfg.max_active_per_user,
    ttl_days: cfg.ttl_days,
    expiry_bundle_hours: cfg.expiry_bundle_hours,
    pending_capacity_ttl_hours: cfg.pending_capacity_ttl_hours,
    tentative_confirm_window_hours: cfg.tentative_confirm_window_hours,
    expiry_reply_window_days: cfg.expiry_reply_window_days,
    retention_days: cfg.retention_days,
  }
}

export async function runTrackingExpirySweep(args: Readonly<{
  token: string
  client?: DiscordRestClient
  store?: DiscordStore
  nowIso?: string
}>): Promise<number> {
  const config = loadConfig()
  if (!config.chat.discord.enabled || !config.chat.discord.tracking.enabled) return 0

  const layout = discordLayout()
  const store = args.store ?? createDiscordStore(layout)
  const client = args.client ?? createDiscordRestClient(args.token)
  const nowIso = args.nowIso ?? systemClock.nowIso()
  const cfg = trackingConfigSlice()

  const prepared = await withStoreLockRetry(layout.lock, async () => {
    let file = pruneTrackingFile({
      file: store.loadTracking(),
      nowIso,
      config: cfg,
    })
    await store.saveTracking(file)
    return planExpiryNotices({ file, nowIso, config: cfg })
  })
  if (!prepared.ok) return 0

  let sent = 0
  for (const plan of prepared.value) {
    const content = renderExpiryNotice({
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
        const file = store.loadTracking()
        const next = applyExpiryNoticeSent({
          file,
          plan,
          noticeMessageId: result.messageId,
          nowIso,
        })
        await store.saveTracking(next)
      })
      if (saved.ok) sent += 1
    } catch (error) {
      log.warn("discord tracking expiry notice failed", {
        userId: plan.userId,
        error: error instanceof Error ? error.message : "unknown",
      })
    }
  }

  // After notices: flip any remaining/bundled actives that have now elapsed
  await withStoreLockRetry(layout.lock, async () => {
    const file = flipElapsedAwaitingReply({
      file: store.loadTracking(),
      nowIso,
    })
    await store.saveTracking(file)
  })

  return sent
}

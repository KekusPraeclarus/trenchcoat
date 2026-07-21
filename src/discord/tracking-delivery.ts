import { createHash } from "node:crypto"
import { systemClock } from "../lib/clock.js"
import { WorkspaceLock } from "../lib/lock.js"
import { log } from "../lib/log.js"
import type { DiscordRestClient } from "./bot-client.js"
import { chunkDiscordReply, partDeliveryKey } from "./render.js"
import { discordLayout } from "./paths.js"
import type { DiscordStore } from "./store.js"
import type { TrackingDeliveryRecord } from "./schemas.js"
import { renderTrackingPing } from "./tracking-sanitize.js"

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

export function syntheticSnowflake(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 15)
  const n = BigInt(`0x${hex}`)
  const s = n.toString()
  return s.length >= 17 ? s.slice(0, 19) : s.padStart(17, "1")
}

export async function deliverTrackingPing(args: Readonly<{
  client: DiscordRestClient
  store: DiscordStore
  delivery: TrackingDeliveryRecord
  nowIso?: string
}>): Promise<{ ok: true; delivery: TrackingDeliveryRecord } | { ok: false; delivery: TrackingDeliveryRecord; ambiguous?: boolean }> {
  const nowIso = args.nowIso ?? systemClock.nowIso()
  const layout = discordLayout()
  let delivery = args.delivery

  if (delivery.status === "delivered" || delivery.status === "terminal") {
    return { ok: true, delivery }
  }

  const pingText = renderTrackingPing(delivery.userId, delivery.reason)
  const followParts = delivery.researchSummary
    ? chunkDiscordReply(delivery.researchSummary)
    : []
  const parts = [pingText, ...followParts]
  const delivered = new Set(delivery.deliveredPartKeys)
  const messageIds = [...delivery.discordMessageIds]
  let pingMessageId = delivery.pingMessageId

  const markSending = await withStoreLockRetry(layout.lock, async () => {
    const file = args.store.loadTracking()
    const idx = file.trackingDeliveries.findIndex((d) => d.deliveryId === delivery.deliveryId)
    if (idx < 0) return undefined
    const current = file.trackingDeliveries[idx]!
    if (current.status === "delivered" || current.status === "terminal") return current
    if (current.status === "sending") {
      const terminal: TrackingDeliveryRecord = {
        ...current,
        status: "terminal",
        updatedAt: nowIso,
        lastError: "ambiguous-send-not-retried",
      }
      file.trackingDeliveries[idx] = terminal
      await args.store.saveTracking(file)
      return terminal
    }
    const next: TrackingDeliveryRecord = {
      ...current,
      status: "sending",
      attemptCount: current.attemptCount + 1,
      parts,
      updatedAt: nowIso,
    }
    file.trackingDeliveries[idx] = next
    await args.store.saveTracking(file)
    return next
  })
  if (!markSending.ok || !markSending.value) {
    return { ok: false, delivery }
  }
  delivery = markSending.value
  if (delivery.status === "terminal") {
    return { ok: false, delivery, ambiguous: true }
  }

  for (let i = 0; i < parts.length; i += 1) {
    const content = parts[i]!
    const key = partDeliveryKey(delivery.deliveryId, i, content)
    if (delivered.has(key)) continue
    try {
      let sent
      try {
        sent = await args.client.sendReply({
          channelId: delivery.channelId,
          content,
          replyToMessageId: i === 0
            ? delivery.anchorMessageId
            : (pingMessageId ?? delivery.anchorMessageId),
          mentionUserIds: i === 0 ? [delivery.userId] : [],
        })
      } catch (error) {
        const err = error as Error & { unknownMessage?: boolean }
        if (err.unknownMessage) {
          sent = await args.client.sendChannelMessage({
            channelId: delivery.channelId,
            content,
            mentionUserIds: [delivery.userId],
          })
        } else {
          throw error
        }
      }
      delivered.add(key)
      messageIds.push(sent.messageId)
      if (i === 0) pingMessageId = sent.messageId

      const persisted = await withStoreLockRetry(layout.lock, async () => {
        const file = args.store.loadTracking()
        const idx = file.trackingDeliveries.findIndex((d) => d.deliveryId === delivery.deliveryId)
        if (idx < 0) return undefined
        const next: TrackingDeliveryRecord = {
          ...file.trackingDeliveries[idx]!,
          deliveredPartKeys: [...delivered],
          discordMessageIds: [...messageIds],
          ...(pingMessageId ? { pingMessageId } : {}),
          parts,
          updatedAt: nowIso,
        }
        file.trackingDeliveries[idx] = next
        await args.store.saveTracking(file)
        return next
      })
      if (persisted.ok && persisted.value) delivery = persisted.value
    } catch (error) {
      const failed = await withStoreLockRetry(layout.lock, async () => {
        const file = args.store.loadTracking()
        const idx = file.trackingDeliveries.findIndex((d) => d.deliveryId === delivery.deliveryId)
        if (idx < 0) return delivery
        const next: TrackingDeliveryRecord = {
          ...file.trackingDeliveries[idx]!,
          status: "terminal",
          updatedAt: nowIso,
          lastError: (error instanceof Error ? error.message : "send failed").slice(0, 280),
        }
        file.trackingDeliveries[idx] = next
        await args.store.saveTracking(file)
        return next
      })
      return {
        ok: false,
        delivery: failed.ok ? failed.value : delivery,
        ambiguous: true,
      }
    }
  }

  const completed = await withStoreLockRetry(layout.lock, async () => {
    const file = args.store.loadTracking()
    const idx = file.trackingDeliveries.findIndex((d) => d.deliveryId === delivery.deliveryId)
    if (idx < 0) return delivery
    const next: TrackingDeliveryRecord = {
      ...file.trackingDeliveries[idx]!,
      status: "delivered",
      deliveredPartKeys: [...delivered],
      discordMessageIds: [...messageIds],
      ...(pingMessageId ? { pingMessageId } : {}),
      parts,
      updatedAt: nowIso,
    }
    file.trackingDeliveries[idx] = next
    await args.store.saveTracking(file)
    return next
  })
  delivery = completed.ok ? completed.value : delivery

  if (delivery.needsResearch && !delivery.researchEnqueued && !delivery.researchSummary) {
    try {
      const { acceptDiscordRequest } = await import("./pump.js")
      const accepted = await acceptDiscordRequest({
        guildId: delivery.guildId,
        channelId: delivery.channelId,
        messageId: syntheticSnowflake(`trk-research:${delivery.deliveryId}`),
        userId: delivery.userId,
        subject: delivery.subject,
        origin: "tracking",
        trackingPingMessageId: delivery.pingMessageId ?? delivery.anchorMessageId,
        trackingId: delivery.trackingId,
      })
      const enqueued = ("accepted" in accepted && accepted.accepted)
        || ("duplicate" in accepted)
      await withStoreLockRetry(layout.lock, async () => {
        const file = args.store.loadTracking()
        const idx = file.trackingDeliveries.findIndex((d) => d.deliveryId === delivery.deliveryId)
        if (idx < 0) return
        file.trackingDeliveries[idx] = {
          ...file.trackingDeliveries[idx]!,
          researchEnqueued: enqueued,
          updatedAt: systemClock.nowIso(),
          ...(!enqueued ? { lastError: "research-enqueue-failed" } : {}),
        }
        await args.store.saveTracking(file)
      })
      if (enqueued && "accepted" in accepted && accepted.accepted) {
        // Kick the research pump without creating a hard import cycle at module load
        const { processNextDiscordRequest } = await import("./pump.js")
        const token = process.env["DISCORD_RESEARCH_BOT_TOKEN"]
        if (token) {
          void processNextDiscordRequest({
            repoRoot: process.cwd(),
            token,
          }).catch((error) => {
            log.warn("tracking research pump kick failed", {
              error: error instanceof Error ? error.message : "unknown",
            })
          })
        }
      }
    } catch (error) {
      log.warn("tracking research enqueue failed", {
        deliveryId: delivery.deliveryId,
        error: error instanceof Error ? error.message : "unknown",
      })
    }
  }

  return { ok: true, delivery }
}

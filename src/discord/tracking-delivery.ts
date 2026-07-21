import { createHash } from "node:crypto"
import { systemClock } from "../lib/clock.js"
import { WorkspaceLock } from "../lib/lock.js"
import { log } from "../lib/log.js"
import type { DiscordRestClient } from "./bot-client.js"
import { chunkDiscordReply, partDeliveryKey } from "./render.js"
import { discordLayout } from "./paths.js"
import type { DiscordStore } from "./store.js"
import type { TrackingDeliveryRecord } from "./schemas.js"
import { renderTrackingAlertBody } from "./tracking-sanitize.js"
import { markDeliveryMatchedSubject } from "./tracking-state.js"

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

/** Enqueue silent tracking-origin research for a research-pending delivery */
export async function enqueueTrackingResearch(args: Readonly<{
  store: DiscordStore
  delivery: TrackingDeliveryRecord
  repoRoot: string
  nowIso?: string
}>): Promise<{ ok: boolean; delivery: TrackingDeliveryRecord }> {
  const nowIso = args.nowIso ?? systemClock.nowIso()
  const layout = discordLayout()
  let delivery = args.delivery
  if (delivery.researchEnqueued || delivery.status === "delivered" || delivery.status === "terminal") {
    return { ok: true, delivery }
  }
  if (delivery.status !== "research-pending" && delivery.status !== "pending") {
    return { ok: false, delivery }
  }

  try {
    const { acceptDiscordRequest, processNextDiscordRequest } = await import("./pump.js")
    const subject = delivery.chain && delivery.tokenAddress
      ? `${delivery.chain}:${delivery.tokenAddress}`
      : (delivery.tokenQuery ?? delivery.subject)
    const accepted = await acceptDiscordRequest({
      guildId: delivery.guildId,
      channelId: delivery.channelId,
      messageId: syntheticSnowflake(`trk-research:${delivery.deliveryId}`),
      userId: delivery.userId,
      subject,
      ...(delivery.chain ? { chainHint: delivery.chain } : {}),
      ...(delivery.tokenAddress ? { tokenHint: delivery.tokenAddress } : {}),
      origin: "tracking",
      trackingId: delivery.trackingId,
      trackingDeliveryId: delivery.deliveryId,
      trackingShortLabel: delivery.shortLabel ?? "tracked idea",
      trackingQualificationSource: delivery.qualificationSource ?? "main-track",
    })
    const enqueued = ("accepted" in accepted && accepted.accepted)
      || ("duplicate" in accepted)

    const persisted = await withStoreLockRetry(layout.lock, async () => {
      const file = args.store.loadTracking()
      const idx = file.trackingDeliveries.findIndex((d) => d.deliveryId === delivery.deliveryId)
      if (idx < 0) return delivery
      const next: TrackingDeliveryRecord = {
        ...file.trackingDeliveries[idx]!,
        researchEnqueued: enqueued,
        researchRequestId: syntheticSnowflake(`trk-research:${delivery.deliveryId}`),
        updatedAt: nowIso,
        ...(!enqueued ? { lastError: "research-enqueue-failed" } : {}),
      }
      file.trackingDeliveries[idx] = next
      await args.store.saveTracking(file)
      return next
    })
    delivery = persisted.ok ? persisted.value : delivery

    if (enqueued && "accepted" in accepted && accepted.accepted) {
      const token = process.env["DISCORD_RESEARCH_BOT_TOKEN"]
      if (token) {
        void processNextDiscordRequest({
          repoRoot: args.repoRoot,
          token,
        }).catch((error) => {
          log.warn("tracking research pump kick failed", {
            error: error instanceof Error ? error.message : "unknown",
          })
        })
      }
    }
    return { ok: enqueued, delivery }
  } catch (error) {
    log.warn("tracking research enqueue failed", {
      deliveryId: delivery.deliveryId,
      error: error instanceof Error ? error.message : "unknown",
    })
    return { ok: false, delivery }
  }
}

/**
 * Deliver a qualified tracking alert as channel messages (never a reply to the
 * original tracking request). First part mentions only the owner.
 */
export async function deliverTrackingAlert(args: Readonly<{
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
  if (delivery.status !== "qualified-pending" && delivery.status !== "sending") {
    return { ok: false, delivery }
  }
  if (!delivery.researchSummary?.trim()) {
    return { ok: false, delivery }
  }

  const body = renderTrackingAlertBody({
    userId: delivery.userId,
    shortLabel: delivery.shortLabel ?? "tracked idea",
    researchText: delivery.researchSummary,
    ...(delivery.securityWarning ? { securityWarning: delivery.securityWarning } : {}),
  })
  const parts = chunkDiscordReply(body)
  const delivered = new Set(delivery.deliveredPartKeys)
  const messageIds = [...delivery.discordMessageIds]

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
      const sent = await args.client.sendChannelMessage({
        channelId: delivery.channelId,
        content,
        mentionUserIds: i === 0 ? [delivery.userId] : [],
      })
      delivered.add(key)
      messageIds.push(sent.messageId)

      const persisted = await withStoreLockRetry(layout.lock, async () => {
        const file = args.store.loadTracking()
        const idx = file.trackingDeliveries.findIndex((d) => d.deliveryId === delivery.deliveryId)
        if (idx < 0) return undefined
        const next: TrackingDeliveryRecord = {
          ...file.trackingDeliveries[idx]!,
          deliveredPartKeys: [...delivered],
          discordMessageIds: [...messageIds],
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
    let file = args.store.loadTracking()
    const idx = file.trackingDeliveries.findIndex((d) => d.deliveryId === delivery.deliveryId)
    if (idx < 0) return delivery
    const next: TrackingDeliveryRecord = {
      ...file.trackingDeliveries[idx]!,
      status: "delivered",
      deliveredPartKeys: [...delivered],
      discordMessageIds: [...messageIds],
      parts,
      updatedAt: nowIso,
    }
    file.trackingDeliveries[idx] = next
    file = markDeliveryMatchedSubject({
      file,
      trackingId: next.trackingId,
      normalizedSubject: next.normalizedSubject,
      nowIso,
    })
    await args.store.saveTracking(file)
    return next
  })
  delivery = completed.ok ? completed.value : delivery
  return { ok: true, delivery }
}

/** @deprecated Prefer deliverTrackingAlert — kept for crash tests transitioning statuses */
export async function deliverTrackingPing(args: Readonly<{
  client: DiscordRestClient
  store: DiscordStore
  delivery: TrackingDeliveryRecord
  nowIso?: string
}>): Promise<{ ok: true; delivery: TrackingDeliveryRecord } | { ok: false; delivery: TrackingDeliveryRecord; ambiguous?: boolean }> {
  if (args.delivery.status === "qualified-pending" || args.delivery.status === "sending") {
    return deliverTrackingAlert(args)
  }
  return { ok: false, delivery: args.delivery }
}

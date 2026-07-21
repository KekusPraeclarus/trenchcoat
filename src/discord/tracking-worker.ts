import { loadConfig } from "../lib/config.js"
import { systemClock } from "../lib/clock.js"
import { WorkspaceLock } from "../lib/lock.js"
import { log } from "../lib/log.js"
import { createDiscordRestClient } from "./bot-client.js"
import { discordLayout } from "./paths.js"
import { createDiscordStore } from "./store.js"
import type { TrackingMatchBatch } from "./schemas.js"
import { runTrackingMatch } from "./tracking-match.js"
import { deliverTrackingPing } from "./tracking-delivery.js"
import {
  activeMatchableRequests,
  createOrGetDelivery,
  pruneTrackingFile,
  type TrackingConfigSlice,
} from "./tracking-state.js"
import { resolveDiscordRepoRoot } from "./listener.js"

let workerKicked = false

export function kickTrackingWorker(repoRoot?: string): void {
  if (workerKicked) return
  workerKicked = true
  void processTrackingBatches(repoRoot ? { repoRoot } : {})
    .catch((error) => {
      log.warn("discord tracking worker error", {
        error: error instanceof Error ? error.message : "unknown",
      })
    })
    .finally(() => {
      workerKicked = false
    })
}

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

function parseCandidates(digest: string): Array<{ provenance: string; text: string }> {
  try {
    const parsed = JSON.parse(digest) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is { provenance: string; text: string } => (
        typeof item === "object"
        && item !== null
        && typeof (item as { provenance?: unknown }).provenance === "string"
        && typeof (item as { text?: unknown }).text === "string"
      ))
      .slice(0, 500)
      .map((item) => ({
        provenance: item.provenance.slice(0, 256),
        text: item.text.slice(0, 2_000),
      }))
  } catch {
    return [{ provenance: "digest:raw", text: digest.slice(0, 2_000) }]
  }
}

export async function processTrackingBatches(args: Readonly<{
  repoRoot?: string
  token?: string
  maxBatches?: number
}> = {}): Promise<number> {
  const config = loadConfig()
  if (!config.chat.discord.enabled || !config.chat.discord.tracking.enabled) return 0

  const layout = discordLayout()
  const store = createDiscordStore(layout)
  const repoRoot = args.repoRoot ?? resolveDiscordRepoRoot()
  const token = args.token ?? process.env["DISCORD_RESEARCH_BOT_TOKEN"] ?? ""
  if (!token) {
    log.warn("discord tracking worker missing token")
    return 0
  }
  const client = createDiscordRestClient(token)
  const cfg = trackingConfigSlice()
  const maxAttempts = config.chat.discord.tracking.match_max_attempts
  const staleMs = config.chat.discord.tracking.match_stale_running_ms
  let processed = 0
  const limit = args.maxBatches ?? 8

  for (let n = 0; n < limit; n += 1) {
    const nowIso = systemClock.nowIso()
    const claimed = await withStoreLockRetry(layout.lock, async () => {
      let file = pruneTrackingFile({
        file: store.loadTracking(),
        nowIso,
        config: cfg,
      })
      file = {
        ...file,
        matchBatches: file.matchBatches.map((b) => {
          if (b.status !== "running" || !b.claimedAt) return b
          if (Date.parse(nowIso) - Date.parse(b.claimedAt) < staleMs) return b
          return {
            ...b,
            status: "pending" as const,
            updatedAt: nowIso,
            claimedAt: undefined,
            lastError: "stale-running-reclaimed",
          }
        }),
      }

      if (activeMatchableRequests(file, nowIso).length === 0) {
        const empty = file.matchBatches
          .filter((b) => b.status === "pending")
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
        if (empty) {
          const idx = file.matchBatches.findIndex((b) => b.batchId === empty.batchId)
          file.matchBatches[idx] = {
            ...empty,
            status: "completed",
            updatedAt: nowIso,
            lastError: "no-active-requests",
          }
          await store.saveTracking(file)
          return { batch: file.matchBatches[idx]!, skipMatch: true as const }
        }
        await store.saveTracking(file)
        return undefined
      }

      const pending = file.matchBatches
        .filter((b) => {
          if (b.status !== "pending") return false
          if (b.nextAttemptAt && Date.parse(b.nextAttemptAt) > Date.parse(nowIso)) return false
          return true
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
      if (!pending) {
        await store.saveTracking(file)
        return undefined
      }
      const idx = file.matchBatches.findIndex((b) => b.batchId === pending.batchId)
      const next: TrackingMatchBatch = {
        ...pending,
        status: "running",
        attemptCount: pending.attemptCount + 1,
        claimedAt: nowIso,
        updatedAt: nowIso,
      }
      file.matchBatches[idx] = next
      await store.saveTracking(file)
      return { batch: next, skipMatch: false as const }
    })

    if (!claimed.ok || !claimed.value) break
    const { batch, skipMatch } = claimed.value
    processed += 1
    if (skipMatch) continue

    try {
      const fileSnap = store.loadTracking()
      const hits = await runTrackingMatch({
        repoRoot,
        file: fileSnap,
        batch,
        candidates: parseCandidates(batch.candidateDigest),
        nowIso,
      })
      const needsResearch = batch.sourceKind === "list-scan"
        || batch.sourceKind === "farcaster-scan"

      await withStoreLockRetry(layout.lock, async () => {
        let file = store.loadTracking()
        for (const hit of hits) {
          const request = file.requests.find((r) => r.trackingId === hit.trackingId)
          if (!request || request.status !== "active") continue
          const created = createOrGetDelivery({
            file,
            trackingId: hit.trackingId,
            subject: hit.subject,
            reason: hit.reason,
            batchId: batch.batchId,
            sourceKind: batch.sourceKind,
            nowIso,
            request,
            needsResearch,
            ...(batch.researchSummary ? { researchSummary: batch.researchSummary } : {}),
          })
          file = created.file
        }
        const idx = file.matchBatches.findIndex((b) => b.batchId === batch.batchId)
        if (idx >= 0) {
          file.matchBatches[idx] = {
            ...file.matchBatches[idx]!,
            status: "completed",
            updatedAt: nowIso,
            claimedAt: undefined,
            lastError: undefined,
          }
        }
        await store.saveTracking(file)
      })

      const deliveries = store.loadTracking().trackingDeliveries
        .filter((d) => d.batchId === batch.batchId && d.status === "pending")
      for (const delivery of deliveries) {
        await deliverTrackingPing({ client, store, delivery, nowIso })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "match failed"
      await withStoreLockRetry(layout.lock, async () => {
        const file = store.loadTracking()
        const idx = file.matchBatches.findIndex((b) => b.batchId === batch.batchId)
        if (idx < 0) return
        const current = file.matchBatches[idx]!
        const exhausted = current.attemptCount >= maxAttempts
        const delayMs = Math.min(6 * 3_600_000, 30_000 * (2 ** Math.max(0, current.attemptCount - 1)))
        file.matchBatches[idx] = {
          ...current,
          status: exhausted ? "failed" : "pending",
          updatedAt: systemClock.nowIso(),
          claimedAt: undefined,
          lastError: message.slice(0, 280),
          ...(exhausted
            ? {}
            : {
              nextAttemptAt: new Date(Date.parse(systemClock.nowIso()) + delayMs).toISOString(),
            }),
        }
        await store.saveTracking(file)
        if (exhausted) {
          log.warn("discord tracking batch failed permanently", {
            batchId: batch.batchId,
            error: message,
          })
        }
      })
    }
  }

  const pendingDeliveries = store.loadTracking().trackingDeliveries
    .filter((d) => d.status === "pending")
    .slice(0, 20)
  for (const delivery of pendingDeliveries) {
    await deliverTrackingPing({ client, store, delivery })
  }

  return processed
}

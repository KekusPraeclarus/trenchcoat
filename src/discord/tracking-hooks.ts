import { createHash } from "node:crypto"
import { loadConfig } from "../lib/config.js"
import { systemClock } from "../lib/clock.js"
import { WorkspaceLock } from "../lib/lock.js"
import { log } from "../lib/log.js"
import { discordLayout } from "./paths.js"
import { createDiscordStore } from "./store.js"
import type { TrackingMatchSourceKind } from "./schemas.js"
import { matchBatchId } from "./tracking-ids.js"
import { pruneTrackingFile, upsertMatchBatch, type TrackingConfigSlice } from "./tracking-state.js"
import { kickTrackingWorker } from "./tracking-worker.js"

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

export function hashTrackingCandidates(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32)
}

/** Durable enqueue after sealed collect/research — never fails the parent run */
export async function enqueueTrackingMatchBatch(args: Readonly<{
  sourceKind: TrackingMatchSourceKind
  runId: string
  snapshotHash: string
  candidateDigest: string
  researchSummary?: string
  researchSubject?: string
  researchChain?: string
  researchTokenAddress?: string
  mainTrackEligible?: boolean
  kick?: boolean
}>): Promise<{ enqueued: boolean; batchId: string; duplicate?: boolean }> {
  const config = loadConfig()
  const batchId = matchBatchId({
    sourceKind: args.sourceKind,
    runId: args.runId,
    snapshotHash: args.snapshotHash,
  })
  if (!config.chat.discord.enabled || !config.chat.discord.tracking.enabled) {
    return { enqueued: false, batchId }
  }

  const layout = discordLayout()
  const store = createDiscordStore(layout)
  const nowIso = systemClock.nowIso()
  const cfg = trackingConfigSlice()

  try {
    const locked = await withStoreLockRetry(layout.lock, async () => {
      let file = pruneTrackingFile({
        file: store.loadTracking(),
        nowIso,
        config: cfg,
      })
      const before = file.matchBatches.length
      file = upsertMatchBatch(file, {
        batchId,
        sourceKind: args.sourceKind,
        runId: args.runId,
        snapshotHash: args.snapshotHash,
        status: "pending",
        attemptCount: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
        candidateDigest: args.candidateDigest.slice(0, 64_000),
        ...(args.researchSummary
          ? { researchSummary: args.researchSummary.slice(0, 8_000) }
          : {}),
        ...(args.researchSubject
          ? { researchSubject: args.researchSubject.slice(0, 256) }
          : {}),
        ...(args.researchChain
          ? { researchChain: args.researchChain as import("./schemas.js").TrackingMatchBatch["researchChain"] }
          : {}),
        ...(args.researchTokenAddress
          ? { researchTokenAddress: args.researchTokenAddress.slice(0, 128) }
          : {}),
        ...(args.mainTrackEligible !== undefined
          ? { mainTrackEligible: args.mainTrackEligible }
          : {}),
      })
      const duplicate = file.matchBatches.length === before
      await store.saveTracking(file)
      return { duplicate }
    })
    if (!locked.ok) {
      log.warn("discord tracking enqueue lock busy", { batchId })
      return { enqueued: false, batchId }
    }
    if (!locked.value.duplicate && args.kick !== false) {
      kickTrackingWorker()
    }
    return {
      enqueued: !locked.value.duplicate,
      batchId,
      ...(locked.value.duplicate ? { duplicate: true } : {}),
    }
  } catch (error) {
    log.warn("discord tracking enqueue failed", {
      batchId,
      error: error instanceof Error ? error.message : "unknown",
    })
    return { enqueued: false, batchId }
  }
}

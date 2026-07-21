import { loadConfig } from "../lib/config.js"
import { systemClock } from "../lib/clock.js"
import { WorkspaceLock } from "../lib/lock.js"
import { log } from "../lib/log.js"
import { resolveResearchSubject } from "../orchestrator/research-collect.js"
import { createDiscordRestClient } from "./bot-client.js"
import { discordLayout } from "./paths.js"
import { createDiscordStore } from "./store.js"
import type { TrackingDeliveryRecord, TrackingMatchBatch } from "./schemas.js"
import { runTrackingMatch, type TrackingMatchCandidate, type TrackingMatchHit } from "./tracking-match.js"
import {
  deliverTrackingAlert,
  enqueueTrackingResearch,
} from "./tracking-delivery.js"
import { runTrackingMentionReview } from "./tracking-qualify.js"
import {
  activeMatchableRequests,
  appendUniqueMention,
  createOrGetDelivery,
  isDeliveryBlacklisted,
  pruneTrackingFile,
  trackingChainAllows,
  type TrackingConfigSlice,
} from "./tracking-state.js"
import { addDaysIso } from "./tracking-ids.js"
import { resolveDiscordRepoRoot } from "./listener.js"
import { findCandidateTextByProvenance } from "./tracking-token-query.js"

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

function parseCandidates(digest: string): TrackingMatchCandidate[] {
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

async function handleHit(args: Readonly<{
  hit: TrackingMatchHit
  batch: TrackingMatchBatch
  candidates: readonly TrackingMatchCandidate[]
  repoRoot: string
  store: ReturnType<typeof createDiscordStore>
  layout: ReturnType<typeof discordLayout>
  nowIso: string
  blacklistDays: number
}>): Promise<void> {
  const { hit, batch, candidates, repoRoot, store, layout, nowIso, blacklistDays } = args
  const candidateText = findCandidateTextByProvenance(candidates, hit.candidateProvenance)
  if (!candidateText) return

  // Research-origin batches carry host qualification metadata
  if (batch.sourceKind === "research" || batch.sourceKind === "discord-research") {
    if (batch.mainTrackEligible !== true) return
    const researchChain = batch.researchChain
    const researchTokenAddress = batch.researchTokenAddress
    const researchSummary = batch.researchSummary
    if (!researchChain || !researchTokenAddress || !researchSummary) return

    const locked = await withStoreLockRetry(layout.lock, async () => {
      const file = store.loadTracking()
      const request = file.requests.find((r) => r.trackingId === hit.trackingId)
      if (!request || request.status !== "active") return undefined
      if (!trackingChainAllows(request.chain, researchChain)) return undefined
      const created = createOrGetDelivery({
        file,
        trackingId: hit.trackingId,
        subject: `${researchChain}:${researchTokenAddress}`,
        reason: hit.reason,
        batchId: batch.batchId,
        sourceKind: batch.sourceKind,
        nowIso,
        request,
        needsResearch: false,
        researchSummary,
        tokenQuery: hit.tokenQuery,
        candidateProvenance: hit.candidateProvenance,
        chain: researchChain,
        tokenAddress: researchTokenAddress,
        shortLabel: request.shortLabel,
        qualificationSource: "main-track",
        status: "qualified-pending",
      })
      await store.saveTracking(created.file)
      return created.delivery
    })
    if (!locked.ok || !locked.value) return
    if (locked.value.status !== "qualified-pending") return
    return
  }

  // Resolve with the request's chain constraint when present (cross-chain fail closed)
  const requestBefore = store.loadTracking().requests.find((r) => r.trackingId === hit.trackingId)
  if (!requestBefore || requestBefore.status !== "active") return
  const resolved = await resolveResearchSubject({
    subject: hit.resolveSubject,
    ...(requestBefore.chain ? { chainHint: requestBefore.chain } : {}),
  })
  if (resolved.status !== "resolved") return
  const identity = resolved.identity
  if (!trackingChainAllows(requestBefore.chain, identity.chain)) return

  const locked = await withStoreLockRetry(layout.lock, async () => {
    let file = store.loadTracking()
    const request = file.requests.find((r) => r.trackingId === hit.trackingId)
    if (!request || request.status !== "active") return { action: "skip" as const }
    if (!trackingChainAllows(request.chain, identity.chain)) return { action: "skip" as const }

    const created = createOrGetDelivery({
      file,
      trackingId: hit.trackingId,
      subject: `${identity.chain}:${identity.tokenAddress}`,
      reason: hit.reason,
      batchId: batch.batchId,
      sourceKind: batch.sourceKind,
      nowIso,
      request,
      needsResearch: true,
      tokenQuery: hit.tokenQuery,
      candidateProvenance: hit.candidateProvenance,
      chain: identity.chain,
      tokenAddress: identity.tokenAddress,
      shortLabel: request.shortLabel,
      status: "research-pending",
    })
    file = created.file
    let delivery = created.delivery

    if (isDeliveryBlacklisted(delivery, nowIso)) {
      await store.saveTracking(file)
      return { action: "skip" as const }
    }

    // Expiry of blacklist → restart initial research flow
    if (
      delivery.status === "suppressed"
      && delivery.blacklistedUntil
      && Date.parse(delivery.blacklistedUntil) <= Date.parse(nowIso)
    ) {
      delivery = {
        ...delivery,
        status: "research-pending",
        blacklistedUntil: undefined,
        researchEnqueued: false,
        mentionItems: [],
        qualificationSource: undefined,
        updatedAt: nowIso,
      }
      const idx = file.trackingDeliveries.findIndex((d) => d.deliveryId === delivery.deliveryId)
      if (idx >= 0) file.trackingDeliveries[idx] = delivery
    }

    if (delivery.status === "delivered" || delivery.status === "terminal") {
      await store.saveTracking(file)
      return { action: "skip" as const }
    }

    if (delivery.status === "awaiting-mentions") {
      const appended = appendUniqueMention({
        delivery,
        provenance: hit.candidateProvenance,
        text: candidateText,
        nowIso,
      })
      delivery = appended.delivery
      const idx = file.trackingDeliveries.findIndex((d) => d.deliveryId === delivery.deliveryId)
      if (idx >= 0) file.trackingDeliveries[idx] = delivery
      await store.saveTracking(file)
      if (!appended.added) return { action: "skip" as const }
      if (delivery.mentionItems.length < 3) return { action: "skip" as const }
      return { action: "review" as const, delivery }
    }

    if (
      delivery.status === "research-pending"
      || delivery.status === "pending"
      || delivery.status === "qualified-pending"
      || delivery.status === "sending"
    ) {
      await store.saveTracking(file)
      if (
        (delivery.status === "research-pending" || delivery.status === "pending")
        && !delivery.researchEnqueued
      ) {
        return { action: "research" as const, delivery }
      }
      return { action: "skip" as const }
    }

    if (created.created) {
      await store.saveTracking(file)
      return { action: "research" as const, delivery }
    }

    await store.saveTracking(file)
    return { action: "skip" as const }
  })

  if (!locked.ok || !locked.value || locked.value.action === "skip") return

  if (locked.value.action === "research") {
    await enqueueTrackingResearch({
      store,
      delivery: locked.value.delivery,
      repoRoot,
      nowIso,
    })
    return
  }

  if (locked.value.action === "review") {
    const delivery = locked.value.delivery
    const review = await runTrackingMentionReview({
      repoRoot,
      delivery,
      mentions: delivery.mentionItems.slice(-3),
      nowIso,
    })
    await withStoreLockRetry(layout.lock, async () => {
      const file = store.loadTracking()
      const idx = file.trackingDeliveries.findIndex((d) => d.deliveryId === delivery.deliveryId)
      if (idx < 0) return
      const current = file.trackingDeliveries[idx]!
      if (review.verdict === "reject") {
        file.trackingDeliveries[idx] = {
          ...current,
          status: "suppressed",
          blacklistedUntil: addDaysIso(nowIso, blacklistDays),
          mentionItems: [],
          updatedAt: nowIso,
          lastError: review.reason.slice(0, 280),
        }
      } else {
        file.trackingDeliveries[idx] = {
          ...current,
          status: "research-pending",
          needsResearch: true,
          researchEnqueued: false,
          qualificationSource: "three-mention-review",
          mentionItems: [],
          updatedAt: nowIso,
          lastError: undefined,
        }
      }
      await store.saveTracking(file)
    })
    if (review.verdict === "approve") {
      const fresh = store.loadTracking().trackingDeliveries
        .find((d) => d.deliveryId === delivery.deliveryId)
      if (fresh) {
        await enqueueTrackingResearch({ store, delivery: fresh, repoRoot, nowIso })
      }
    }
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
  const blacklistDays = config.chat.discord.tracking.mention_review_blacklist_days
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
      const candidates = parseCandidates(batch.candidateDigest)
      const hits = await runTrackingMatch({
        repoRoot,
        file: fileSnap,
        batch,
        candidates,
        nowIso,
      })

      for (const hit of hits) {
        await handleHit({
          hit,
          batch,
          candidates: batch.researchSummary
            ? [
              {
                provenance: `research:${batch.researchSubject ?? batch.runId}`,
                text: batch.researchSummary.slice(0, 2_000),
              },
              ...candidates,
            ]
            : candidates,
          repoRoot,
          store,
          layout,
          nowIso,
          blacklistDays,
        })
      }

      await withStoreLockRetry(layout.lock, async () => {
        const file = store.loadTracking()
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

  // Drain qualified alerts and research-pending enqueue leftovers
  const pendingResearch = store.loadTracking().trackingDeliveries
    .filter((d) => (
      (d.status === "research-pending" || d.status === "pending")
      && d.needsResearch
      && !d.researchEnqueued
    ))
    .slice(0, 10)
  for (const delivery of pendingResearch) {
    await enqueueTrackingResearch({ store, delivery, repoRoot })
  }

  const qualified = store.loadTracking().trackingDeliveries
    .filter((d) => d.status === "qualified-pending")
    .slice(0, 20)
  for (const delivery of qualified) {
    await deliverTrackingAlert({ client, store, delivery })
  }

  return processed
}

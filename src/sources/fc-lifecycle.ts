import { sha256Json } from "../lib/canonical-json.js"
import { applyTransitionsCap } from "../wallets/lifecycle.js"
import type {
  FcDiscoveryOrigin,
  FcSourceCandidate,
  FcSourceLifecycleFile,
  FcSourceLifecycleTransition,
  SourcePerformance,
} from "../contracts/schemas.js"
import type { SourceLifecycleThresholds } from "./lifecycle.js"
import { idleDays } from "./lifecycle.js"

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,15}$/u

export function normalizeFcHandle(raw: string): string | undefined {
  const handle = raw.replace(/^@/u, "").trim().toLowerCase()
  if (!HANDLE_RE.test(handle)) return undefined
  return handle
}

export function sourceIdForFcHandle(handle: string): string {
  return `fc_${handle.toLowerCase()}`
}

const FC_ORIGINS: readonly FcDiscoveryOrigin[] = [
  "fc-fyp",
  "fc-channel-1",
  "fc-channel-2",
]

export function isFcDiscoveryOrigin(value: string): value is FcDiscoveryOrigin {
  return (FC_ORIGINS as readonly string[]).includes(value)
}

export function registerFcDiscoveryCandidates(
  file: FcSourceLifecycleFile,
  sightings: readonly Readonly<{
    handle: string
    fid: number
    origin: FcDiscoveryOrigin
  }>[],
  seenAt: string,
): FcSourceLifecycleFile {
  const byId = new Map(file.candidates.map((c) => [c.sourceId, c]))
  for (const sighting of sightings) {
    if (!isFcDiscoveryOrigin(sighting.origin)) continue
    if (!Number.isInteger(sighting.fid) || sighting.fid < 1) continue
    const handle = normalizeFcHandle(sighting.handle)
    if (!handle) continue
    const sourceId = sourceIdForFcHandle(handle)
    const existing = byId.get(sourceId)
    if (existing) {
      byId.set(sourceId, {
        ...existing,
        fid: sighting.fid,
        lastSeenAt: seenAt,
      })
      continue
    }
    const candidate: FcSourceCandidate = {
      schema: 1,
      sourceId,
      handle,
      fid: sighting.fid,
      discoveredFrom: sighting.origin,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      status: "probation",
      consecutiveBelowFloorEpochs: 0,
      hardDocked: false,
      evidenceHash: sha256Json({
        sourceId,
        handle,
        fid: sighting.fid,
        firstSeenAt: seenAt,
        discoveredFrom: sighting.origin,
      }),
    }
    byId.set(sourceId, candidate)
  }
  return {
    ...file,
    candidates: [...byId.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
  }
}

function shouldPromoteFc(
  candidate: FcSourceCandidate,
  perf: SourcePerformance | undefined,
  nowIso: string,
  thresholds: SourceLifecycleThresholds,
): boolean {
  if (candidate.status !== "probation" && candidate.status !== "demoted") return false
  if (candidate.hardDocked) return false
  if (!perf) return false

  if (candidate.status === "demoted") {
    if (candidate.cooldownUntil && Date.parse(nowIso) < Date.parse(candidate.cooldownUntil)) {
      return false
    }
    const callsAtDemotion = candidate.callsAtDemotion ?? 0
    if (perf.eligibleCalls < callsAtDemotion + thresholds.demotion.readd_min_new_calls) {
      return false
    }
  }

  const idle = idleDays(perf.lastEligibleCallAt, nowIso)
  return perf.eligibleCalls >= thresholds.promotion.min_eligible_calls
    && perf.distinctTokens >= thresholds.promotion.min_distinct_tokens
    && perf.coverage >= thresholds.promotion.min_coverage
    && perf.hitMean >= thresholds.promotion.min_hit_mean
    && perf.hitLb95 >= thresholds.promotion.min_hit_lb95
    && perf.medianExcess72h >= thresholds.promotion.min_median_excess
    && perf.rugExposure <= thresholds.promotion.max_rug_exposure
    && idle <= thresholds.promotion.max_idle_days
}

function fcDemotionReason(
  candidate: FcSourceCandidate,
  perf: SourcePerformance | undefined,
  nowIso: string,
  thresholds: SourceLifecycleThresholds,
): string | undefined {
  if (candidate.status !== "managed") return undefined
  if (candidate.hardDocked) return "hard_dock"
  if (!perf) return "inactive"

  const idle = idleDays(perf.lastEligibleCallAt, nowIso)
  if (idle >= thresholds.demotion.idle_days) return "inactive"

  if (
    perf.settledCalls >= thresholds.demotion.min_resolved_for_rug_drop
    && perf.rugExposure > thresholds.demotion.rug_exposure
  ) {
    return "rug_exposure"
  }

  const belowFloor = perf.coverage < thresholds.demotion.coverage_floor
    || perf.score < thresholds.demotion.score_floor
  if (
    belowFloor
    && candidate.consecutiveBelowFloorEpochs >= thresholds.demotion.consecutive_epochs
  ) {
    return "below_floor"
  }
  return undefined
}

export type FcLifecycleReviewInput = Readonly<{
  file: FcSourceLifecycleFile
  performances: ReadonlyMap<string, SourcePerformance>
  epochId: string
  nowIso: string
  thresholds: SourceLifecycleThresholds
  capacity: number
}>

export type FcLifecycleReviewResult = Readonly<{
  file: FcSourceLifecycleFile
  applied: readonly FcSourceLifecycleTransition[]
  queued: readonly FcSourceLifecycleTransition[]
  dryRunWouldApply: readonly FcSourceLifecycleTransition[]
}>

function transitionId(args: Readonly<{
  sourceId: string
  action: "promoted" | "demoted"
  epochId: string
  reasonCode: string
}>): `sha256:${string}` {
  return sha256Json(args)
}

export function reviewFcSourceLifecycle(
  input: FcLifecycleReviewInput,
): FcLifecycleReviewResult {
  const proposed: FcSourceLifecycleTransition[] = []
  const working = new Map(input.file.candidates.map((c) => [c.sourceId, { ...c }]))
  let managedCount = [...working.values()].filter((c) => c.status === "managed").length

  for (const candidate of [...working.values()]) {
    const perf = input.performances.get(candidate.sourceId)

    if (candidate.status === "probation" || candidate.status === "demoted") {
      if (!shouldPromoteFc(candidate, perf, input.nowIso, input.thresholds)) continue
      if (managedCount >= input.capacity) continue
      const reasonCode = "promotion_gates"
      proposed.push({
        schema: 1,
        transitionId: transitionId({
          sourceId: candidate.sourceId,
          action: "promoted",
          epochId: input.epochId,
          reasonCode,
        }),
        sourceId: candidate.sourceId,
        handle: candidate.handle,
        fid: candidate.fid,
        action: "promoted",
        reasonCode,
        occurredAt: input.nowIso,
        epochId: input.epochId,
        evidenceHash: candidate.evidenceHash,
        fromStatus: candidate.status,
        toStatus: "managed",
      })
      managedCount += 1
      continue
    }

    if (candidate.status === "managed") {
      const belowFloor = perf
        ? (perf.coverage < input.thresholds.demotion.coverage_floor
          || perf.score < input.thresholds.demotion.score_floor)
        : false
      working.set(candidate.sourceId, {
        ...candidate,
        consecutiveBelowFloorEpochs: belowFloor
          ? candidate.consecutiveBelowFloorEpochs + 1
          : 0,
        lastReviewEpoch: input.epochId,
      })
      const updated = working.get(candidate.sourceId)!
      const reason = fcDemotionReason(updated, perf, input.nowIso, input.thresholds)
      if (!reason) continue
      proposed.push({
        schema: 1,
        transitionId: transitionId({
          sourceId: candidate.sourceId,
          action: "demoted",
          epochId: input.epochId,
          reasonCode: reason,
        }),
        sourceId: candidate.sourceId,
        handle: candidate.handle,
        fid: candidate.fid,
        action: "demoted",
        reasonCode: reason,
        occurredAt: input.nowIso,
        epochId: input.epochId,
        evidenceHash: candidate.evidenceHash,
        fromStatus: "managed",
        toStatus: "demoted",
      })
    }
  }

  const capped = applyTransitionsCap(
    proposed,
    input.thresholds.max_transitions_per_review,
  )

  const next = new Map(input.file.candidates.map((c) => [c.sourceId, { ...c }]))
  // Preserve consecutiveBelowFloorEpochs updates even when demotion is not applied
  for (const [id, updated] of working) {
    const base = next.get(id)
    if (!base) continue
    next.set(id, {
      ...base,
      consecutiveBelowFloorEpochs: updated.consecutiveBelowFloorEpochs,
      lastReviewEpoch: updated.lastReviewEpoch ?? base.lastReviewEpoch,
    })
  }
  for (const t of capped.applied) {
    const current = next.get(t.sourceId)
    if (!current) continue
    if (t.action === "promoted") {
      next.set(t.sourceId, {
        ...current,
        status: "managed",
        promotedAt: input.nowIso,
        consecutiveBelowFloorEpochs: 0,
        lastReviewEpoch: input.epochId,
      })
    } else {
      const perf = input.performances.get(t.sourceId)
      next.set(t.sourceId, {
        ...current,
        status: "demoted",
        demotedAt: input.nowIso,
        callsAtDemotion: perf?.eligibleCalls ?? current.callsAtDemotion,
        lastReviewEpoch: input.epochId,
      })
    }
  }

  return {
    file: {
      ...input.file,
      candidates: [...next.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
      transitions: [...input.file.transitions, ...capped.applied],
      pendingTransitionIds: [
        ...new Set([
          ...input.file.pendingTransitionIds,
          ...capped.applied.map((t) => t.transitionId),
        ]),
      ],
    },
    applied: capped.applied,
    queued: capped.queued,
    dryRunWouldApply: proposed,
  }
}

export function desiredFollowFids(file: FcSourceLifecycleFile): number[] {
  return file.candidates
    .filter((c) => c.status === "managed")
    .map((c) => c.fid)
    .sort((a, b) => a - b)
}

export function computeFollowDiff(args: Readonly<{
  desired: readonly number[]
  currentlyFollowing: readonly number[]
}>): Readonly<{ follow: number[], unfollow: number[] }> {
  const desired = new Set(args.desired)
  const current = new Set(args.currentlyFollowing)
  return {
    follow: [...desired].filter((fid) => !current.has(fid)).sort((a, b) => a - b),
    unfollow: [...current].filter((fid) => !desired.has(fid)).sort((a, b) => a - b),
  }
}

/** Only mutate follows for fids that appear in lifecycle state (fid confinement). */
export function confineFollowTargets(
  targets: readonly number[],
  allowedFids: ReadonlySet<number>,
): number[] {
  return targets.filter((fid) => allowedFids.has(fid))
}

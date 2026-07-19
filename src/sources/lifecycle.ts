import { sha256Json } from "../lib/canonical-json.js"
import { applyTransitionsCap } from "../wallets/lifecycle.js"
import type {
  SourceCandidate,
  SourceDiscoveryOrigin,
  SourceLifecycleFile,
  SourceLifecycleTransition,
  SourcePerformance,
} from "../contracts/schemas.js"

export type SourceLifecycleThresholds = Readonly<{
  max_transitions_per_review: number
  promotion: Readonly<{
    min_eligible_calls: number
    min_distinct_tokens: number
    min_coverage: number
    min_hit_mean: number
    min_hit_lb95: number
    min_median_excess: number
    max_rug_exposure: number
    max_idle_days: number
  }>
  demotion: Readonly<{
    idle_days: number
    rug_exposure: number
    min_resolved_for_rug_drop: number
    coverage_floor: number
    score_floor: number
    consecutive_epochs: number
    readd_cooldown_days: number
    readd_min_new_calls: number
  }>
}>

export type LifecycleReviewInput = Readonly<{
  file: SourceLifecycleFile
  performances: ReadonlyMap<string, SourcePerformance>
  epochId: string
  nowIso: string
  thresholds: SourceLifecycleThresholds
  capacity: number
}>

export type LifecycleReviewResult = Readonly<{
  file: SourceLifecycleFile
  applied: readonly SourceLifecycleTransition[]
  queued: readonly SourceLifecycleTransition[]
  dryRunWouldApply: readonly SourceLifecycleTransition[]
}>

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/u

export function normalizeHandle(raw: string): string | undefined {
  const handle = raw.replace(/^@/u, "").trim()
  if (!HANDLE_RE.test(handle)) return undefined
  return handle
}

export function sourceIdForHandle(handle: string): string {
  return `x_${handle.toLowerCase()}`
}

const DISCOVERY_ORIGINS: readonly SourceDiscoveryOrigin[] = [
  "fyp",
  "operator-list-1",
  "operator-list-2",
  "fomo-leaderboard",
]

export function isDiscoveryOrigin(value: string): value is SourceDiscoveryOrigin {
  return (DISCOVERY_ORIGINS as readonly string[]).includes(value)
}

/** Register shill-probation candidates from FYP or either immutable operator list. */
export function registerDiscoveryCandidates(
  file: SourceLifecycleFile,
  sightings: readonly Readonly<{ handle: string, origin: SourceDiscoveryOrigin }>[],
  seenAt: string,
): SourceLifecycleFile {
  const byId = new Map(file.candidates.map((c) => [c.sourceId, c]))
  for (const sighting of sightings) {
    if (!isDiscoveryOrigin(sighting.origin)) continue
    const handle = normalizeHandle(sighting.handle)
    if (!handle) continue
    const sourceId = sourceIdForHandle(handle)
    const existing = byId.get(sourceId)
    if (existing) {
      byId.set(sourceId, {
        ...existing,
        lastSeenAt: seenAt,
      })
      continue
    }
    const candidate: SourceCandidate = {
      schema: 1,
      sourceId,
      handle,
      discoveredFrom: sighting.origin,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      status: "probation",
      consecutiveBelowFloorEpochs: 0,
      hardDocked: false,
      evidenceHash: sha256Json({
        sourceId,
        handle,
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

/** @deprecated prefer registerDiscoveryCandidates */
export function registerFypCandidates(
  file: SourceLifecycleFile,
  authors: readonly string[],
  seenAt: string,
): SourceLifecycleFile {
  return registerDiscoveryCandidates(
    file,
    authors.map((handle) => ({ handle, origin: "fyp" as const })),
    seenAt,
  )
}

export function idleDays(lastEligibleCallAt: string | undefined, nowIso: string): number {
  if (!lastEligibleCallAt) return Number.POSITIVE_INFINITY
  const delta = Date.parse(nowIso) - Date.parse(lastEligibleCallAt)
  if (!Number.isFinite(delta) || delta < 0) return Number.POSITIVE_INFINITY
  return delta / 86_400_000
}

export function shouldPromoteSource(
  candidate: SourceCandidate,
  perf: SourcePerformance,
  nowIso: string,
  thresholds: SourceLifecycleThresholds,
): boolean {
  if (candidate.status !== "probation" && candidate.status !== "demoted") return false
  if (candidate.hardDocked) return false
  if (!isDiscoveryOrigin(candidate.discoveredFrom)) return false

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

export function demotionReason(
  candidate: SourceCandidate,
  perf: SourcePerformance,
  nowIso: string,
  thresholds: SourceLifecycleThresholds,
): string | undefined {
  if (candidate.status !== "managed") return undefined
  if (candidate.hardDocked) return "hard_dock"

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

function buildTransition(args: Readonly<{
  candidate: SourceCandidate
  action: "promoted" | "demoted"
  reasonCode: string
  occurredAt: string
  epochId: string
  evidenceHash: `sha256:${string}`
}>): SourceLifecycleTransition {
  const fromStatus = args.candidate.status
  const toStatus = args.action === "promoted" ? "managed" : "demoted"
  const transitionId = sha256Json({
    sourceId: args.candidate.sourceId,
    action: args.action,
    reasonCode: args.reasonCode,
    epochId: args.epochId,
    evidenceHash: args.evidenceHash,
  })
  return {
    schema: 1,
    transitionId,
    sourceId: args.candidate.sourceId,
    handle: args.candidate.handle,
    action: args.action,
    reasonCode: args.reasonCode,
    occurredAt: args.occurredAt,
    epochId: args.epochId,
    evidenceHash: args.evidenceHash,
    fromStatus,
    toStatus,
  }
}

function evidenceFromPerf(
  sourceId: string,
  perf: SourcePerformance,
  reason: string,
  epochId: string,
): `sha256:${string}` {
  return sha256Json({
    sourceId,
    reason,
    epochId,
    eligibleCalls: perf.eligibleCalls,
    distinctTokens: perf.distinctTokens,
    settledCalls: perf.settledCalls,
    hits: perf.hits,
    coverage: perf.coverage,
    hitMean: perf.hitMean,
    hitLb95: perf.hitLb95,
    medianExcess72h: perf.medianExcess72h,
    rugExposure: perf.rugExposure,
    score: perf.score,
    scoreCutoff: perf.scoreCutoff,
    ...(perf.lastEligibleCallAt ? { lastEligibleCallAt: perf.lastEligibleCallAt } : {}),
  })
}

export function reviewSourceLifecycle(input: LifecycleReviewInput): LifecycleReviewResult {
  const known = new Set(input.file.transitions.map((t) => t.transitionId))
  const proposals: SourceLifecycleTransition[] = []
  const updatedCandidates: SourceCandidate[] = []
  const managedCount = input.file.candidates.filter((c) => c.status === "managed").length
  let slots = Math.max(0, input.capacity - managedCount)

  for (const candidate of input.file.candidates) {
    const perf = input.performances.get(candidate.sourceId) ?? emptyPerf(input.nowIso)
    let next = { ...candidate, lastReviewEpoch: input.epochId }

    const belowFloor = perf.coverage < input.thresholds.demotion.coverage_floor
      || perf.score < input.thresholds.demotion.score_floor
    if (candidate.status === "managed") {
      next = {
        ...next,
        consecutiveBelowFloorEpochs: belowFloor
          ? candidate.consecutiveBelowFloorEpochs + 1
          : 0,
      }
    }

    const demoteReason = demotionReason(next, perf, input.nowIso, input.thresholds)
    if (demoteReason) {
      const evidenceHash = evidenceFromPerf(
        candidate.sourceId,
        perf,
        demoteReason,
        input.epochId,
      )
      const transition = buildTransition({
        candidate: next,
        action: "demoted",
        reasonCode: demoteReason,
        occurredAt: input.nowIso,
        epochId: input.epochId,
        evidenceHash,
      })
      if (!known.has(transition.transitionId)) {
        proposals.push(transition)
        known.add(transition.transitionId)
      }
      const cooldownMs = input.thresholds.demotion.readd_cooldown_days * 86_400_000
      next = {
        ...next,
        status: "demoted",
        demotedAt: input.nowIso,
        cooldownUntil: new Date(Date.parse(input.nowIso) + cooldownMs).toISOString(),
        callsAtDemotion: perf.eligibleCalls,
        consecutiveBelowFloorEpochs: 0,
        evidenceHash,
      }
      updatedCandidates.push(next)
      continue
    }

    if (shouldPromoteSource(next, perf, input.nowIso, input.thresholds) && slots > 0) {
      const evidenceHash = evidenceFromPerf(
        candidate.sourceId,
        perf,
        "promotion_gate",
        input.epochId,
      )
      const transition = buildTransition({
        candidate: next,
        action: "promoted",
        reasonCode: "promotion_gate",
        occurredAt: input.nowIso,
        epochId: input.epochId,
        evidenceHash,
      })
      if (!known.has(transition.transitionId)) {
        proposals.push(transition)
        known.add(transition.transitionId)
      }
      next = {
        ...next,
        status: "managed",
        promotedAt: input.nowIso,
        demotedAt: undefined,
        cooldownUntil: undefined,
        consecutiveBelowFloorEpochs: 0,
        evidenceHash,
      }
      slots -= 1
    }

    updatedCandidates.push(next)
  }

  // Stable order: demotions first, then promotions by sourceId
  proposals.sort((a, b) => {
    if (a.action !== b.action) return a.action === "demoted" ? -1 : 1
    return a.sourceId.localeCompare(b.sourceId)
  })

  const { applied, queued } = applyTransitionsCap(
    proposals,
    input.thresholds.max_transitions_per_review,
  )

  const appliedIds = new Set(applied.map((t) => t.transitionId))
  const queuedIds = queued.map((t) => t.transitionId)

  // Roll back candidate status for queued (not applied) transitions
  const appliedBySource = new Map(applied.map((t) => [t.sourceId, t]))
  const committedCandidates = updatedCandidates.map((candidate) => {
    const appliedTransition = appliedBySource.get(candidate.sourceId)
    if (appliedTransition) return candidate
    // Find if we proposed but queued — restore prior status from input
    const prior = input.file.candidates.find((c) => c.sourceId === candidate.sourceId)
    if (!prior) return candidate
    const wasQueued = proposals.some(
      (t) => t.sourceId === candidate.sourceId && !appliedIds.has(t.transitionId),
    )
    if (!wasQueued) return candidate
    return {
      ...prior,
      lastReviewEpoch: input.epochId,
      consecutiveBelowFloorEpochs: candidate.consecutiveBelowFloorEpochs,
    }
  })

  const pending = [
    ...input.file.pendingTransitionIds.filter((id) => !appliedIds.has(id)),
    ...applied.map((t) => t.transitionId),
    ...queuedIds,
  ]
  const uniquePending = [...new Set(pending)]

  return {
    file: {
      ...input.file,
      candidates: committedCandidates.sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
      transitions: [...input.file.transitions, ...applied],
      pendingTransitionIds: uniquePending,
    },
    applied,
    queued,
    dryRunWouldApply: applied,
  }
}

export function desiredManagedHandles(file: SourceLifecycleFile): string[] {
  return file.candidates
    .filter((c) => c.status === "managed")
    .map((c) => c.handle)
    .sort((a, b) => a.localeCompare(b))
}

export function markHardDock(
  file: SourceLifecycleFile,
  sourceId: string,
  nowIso: string,
): SourceLifecycleFile {
  return {
    ...file,
    candidates: file.candidates.map((c) => (
      c.sourceId === sourceId
        ? { ...c, hardDocked: true, lastSeenAt: nowIso }
        : c
    )),
  }
}

function emptyPerf(nowIso: string): SourcePerformance {
  return {
    eligibleCalls: 0,
    distinctTokens: 0,
    settledCalls: 0,
    hits: 0,
    coverage: 0,
    hitMean: 0,
    hitLb95: 0,
    medianExcess72h: 0,
    rugExposure: 0,
    score: 0,
    scoreCutoff: nowIso,
  }
}

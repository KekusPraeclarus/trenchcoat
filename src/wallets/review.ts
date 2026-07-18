import { sha256Json } from "../lib/canonical-json.js"
import type {
  WalletPerformance,
  WalletRecord,
  WalletTransition,
  WalletsFile,
} from "../contracts/schemas.js"
import {
  blendWalletScores,
  deterministicWalletScore,
  shouldPromote,
  type HardExclusion,
} from "./scoring.js"
import { performanceToEvidence } from "./outcomes.js"
import { applyTransitionsCap, buildWalletTransition } from "./lifecycle.js"

export type WalletLifecycleThresholds = Readonly<{
  max_transitions_per_review: number
  deterministic_weight: number
  llm_weight: number
  promotion: Readonly<{
    min_effective_buys: number
    min_distinct_tokens: number
    min_coverage: number
    min_deterministic: number
    min_blended: number
    min_hit_mean: number
    min_hit_lb95: number
    min_median_excess: number
    max_rug_exposure: number
    max_idle_days: number
  }>
  drop: Readonly<{
    idle_days: number
    rug_exposure: number
    coverage_floor: number
    deterministic_floor: number
    blended_floor: number
    readd_cooldown_days: number
    readd_min_new_events: number
  }>
}>

export type WalletReviewInput = Readonly<{
  file: WalletsFile
  performances: ReadonlyMap<string, WalletPerformance>
  llmScores: ReadonlyMap<string, number>
  hardExclusions: ReadonlyMap<string, HardExclusion>
  epochId: string
  nowIso: string
  thresholds: WalletLifecycleThresholds
}>

export type WalletReviewResult = Readonly<{
  file: WalletsFile
  applied: readonly WalletTransition[]
  queued: readonly WalletTransition[]
}>

export function shouldDropWallet(
  wallet: WalletRecord,
  perf: WalletPerformance,
  thresholds: WalletLifecycleThresholds["drop"],
  deterministic: number,
  blended: number,
): string | undefined {
  if (wallet.status !== "tracking" && wallet.status !== "tracking-probation") return undefined
  if (perf.idleDays >= thresholds.idle_days) return "inactive"
  if (perf.settledBuys >= 4 && perf.rugExposure > thresholds.rug_exposure) return "rug_exposure"
  if (
    perf.coverage < thresholds.coverage_floor
    || deterministic < thresholds.deterministic_floor
    || blended < thresholds.blended_floor
  ) {
    return "score_floor"
  }
  return undefined
}

export function canReaddWallet(
  wallet: WalletRecord,
  perf: WalletPerformance,
  nowIso: string,
  thresholds: WalletLifecycleThresholds["drop"],
): boolean {
  if (wallet.status !== "dropped") return false
  if (wallet.cooldownUntil && Date.parse(nowIso) < Date.parse(wallet.cooldownUntil)) return false
  const eventsAtDrop = wallet.eventsAtDrop ?? 0
  return perf.effectiveBuys >= eventsAtDrop + thresholds.readd_min_new_events
}

export function reviewWalletLifecycle(input: WalletReviewInput): WalletReviewResult {
  const byId = new Map(input.file.wallets.map((wallet) => [wallet.walletId, { ...wallet }]))
  const proposals: WalletTransition[] = []
  const existingTransitionIds = new Set(input.file.transitions.map((t) => t.transitionId))

  for (const wallet of byId.values()) {
    const exclusion = input.hardExclusions.get(wallet.walletId)
    if (exclusion) {
      wallet.hardExcluded = true
      wallet.hardExclusionReason = exclusion
      wallet.status = "excluded"
      wallet.updatedAt = input.nowIso
      byId.set(wallet.walletId, wallet)
      continue
    }

    const perf = input.performances.get(wallet.walletId)
    if (!perf) continue

    const evidence = performanceToEvidence(perf)
    const deterministic = deterministicWalletScore(evidence)
    const llmScore0to100 = (input.llmScores.get(wallet.walletId) ?? 50)
    const blended = blendWalletScores(
      deterministic,
      llmScore0to100,
      input.thresholds.deterministic_weight,
      input.thresholds.llm_weight,
    )
    wallet.deterministicScore = deterministic
    wallet.llmScore = llmScore0to100 / 100
    wallet.blendedScore = blended
    wallet.updatedAt = input.nowIso
    if (perf.lastEligibleAt) wallet.lastEligibleAt = perf.lastEligibleAt

    if (wallet.status === "dropped" && canReaddWallet(wallet, perf, input.nowIso, input.thresholds.drop)) {
      const promote = shouldPromote({
        effectiveBuys: perf.effectiveBuys,
        distinctTokens: perf.distinctTokens,
        coverage: perf.coverage,
        deterministic,
        blended,
        hitMean: perf.hitMean,
        hitLb95: perf.hitLb95,
        medianExcess: perf.medianExcess,
        rugExposure: perf.rugExposure,
        idleDays: perf.idleDays,
      }, input.thresholds.promotion)
      if (promote) {
        const transition = buildWalletTransition({
          wallet,
          action: "added",
          reasonCode: "readd",
          reasonLine: "re-add after cooldown and new eligible buys",
          occurredAt: input.nowIso,
          runId: input.epochId,
          evidenceHash: sha256Json({ walletId: wallet.walletId, epochId: input.epochId, action: "readd" }),
        })
        if (!existingTransitionIds.has(transition.transitionId)) {
          proposals.push(transition)
          wallet.status = "tracking-probation"
          wallet.promotedAt = input.nowIso
          wallet.droppedAt = undefined
          wallet.cooldownUntil = undefined
        }
      }
    } else if (wallet.status === "candidate" || wallet.status === "tracking-probation") {
      const promote = shouldPromote({
        effectiveBuys: perf.effectiveBuys,
        distinctTokens: perf.distinctTokens,
        coverage: perf.coverage,
        deterministic,
        blended,
        hitMean: perf.hitMean,
        hitLb95: perf.hitLb95,
        medianExcess: perf.medianExcess,
        rugExposure: perf.rugExposure,
        idleDays: perf.idleDays,
      }, input.thresholds.promotion)
      if (promote) {
        const fromCandidate = wallet.status === "candidate"
        const transition = buildWalletTransition({
          wallet,
          action: "added",
          reasonCode: fromCandidate ? "promoted" : "confirmed",
          reasonLine: fromCandidate
            ? "promoted from discovery candidate"
            : "confirmed on tracking after probation",
          occurredAt: input.nowIso,
          runId: input.epochId,
          evidenceHash: sha256Json({
            walletId: wallet.walletId,
            epochId: input.epochId,
            action: fromCandidate ? "promoted" : "confirmed",
          }),
        })
        if (!existingTransitionIds.has(transition.transitionId)) {
          if (fromCandidate) proposals.push(transition)
          wallet.status = "tracking"
          wallet.promotedAt = input.nowIso
        }
      }
    }

    if (wallet.status === "tracking" || wallet.status === "tracking-probation") {
      const dropReason = shouldDropWallet(
        wallet,
        perf,
        input.thresholds.drop,
        deterministic,
        blended,
      )
      if (dropReason) {
        const transition = buildWalletTransition({
          wallet,
          action: "dropped",
          reasonCode: dropReason,
          reasonLine: `dropped: ${dropReason}`,
          occurredAt: input.nowIso,
          runId: input.epochId,
          evidenceHash: sha256Json({
            walletId: wallet.walletId,
            epochId: input.epochId,
            action: "dropped",
            reason: dropReason,
          }),
        })
        if (!existingTransitionIds.has(transition.transitionId)) {
          proposals.push(transition)
          wallet.status = "dropped"
          wallet.droppedAt = input.nowIso
          wallet.eventsAtDrop = perf.effectiveBuys
          wallet.cooldownUntil = new Date(
            Date.parse(input.nowIso) + input.thresholds.drop.readd_cooldown_days * 86_400_000,
          ).toISOString()
        }
      }
    }

    byId.set(wallet.walletId, wallet)
  }

  // Drops before adds
  proposals.sort((a, b) => {
    if (a.action !== b.action) return a.action === "dropped" ? -1 : 1
    return a.walletId.localeCompare(b.walletId)
  })

  const { applied, queued } = applyTransitionsCap(
    proposals,
    input.thresholds.max_transitions_per_review,
  )
  const appliedIds = new Set(applied.map((t) => t.transitionId))

  return {
    file: {
      ...input.file,
      wallets: [...byId.values()].sort((a, b) => a.walletId.localeCompare(b.walletId)),
      transitions: [...input.file.transitions, ...applied],
      pendingTransitionIds: [
        ...input.file.pendingTransitionIds.filter((id) => !appliedIds.has(id)),
        ...queued.map((t) => t.transitionId),
      ],
    },
    applied,
    queued,
  }
}

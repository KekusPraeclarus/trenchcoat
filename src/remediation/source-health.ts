/**
 * Host-owned source-quality ledger and recovery gates (INV-S28).
 * Observations are append-only; models never write this file.
 */

import { createHash } from "node:crypto"
import type {
  ImpactWindow,
  SourceHealthLedger,
  SourceHealthObservation,
  SourceHealthStatus,
} from "./schemas.js"

export const SOURCE_KIND_X_HOME_FYP = "x-home-fyp"
export const SOURCE_KIND_X_OPERATOR_LIST = "x-operator-list"
export const SOURCE_KIND_X_MANAGED_LIST = "x-managed-list"

export function emptySourceHealthLedger(): SourceHealthLedger {
  return { schema: 1, observations: [] }
}

export function observationId(args: Readonly<{
  sourceKind: string
  target: string
  observedAt: string
  sourceCommit?: string
  runId?: string
}>): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      sourceKind: args.sourceKind,
      target: args.target,
      observedAt: args.observedAt,
      sourceCommit: args.sourceCommit ?? "",
      runId: args.runId ?? "",
    }))
    .digest("hex")
  return `sho_${digest.slice(0, 24)}`
}

/** Classify an X scrape observation. Empty FYP without cursor is unhealthy. */
export function classifyXScanObservation(args: Readonly<{
  targetKind: "home" | "operator-list" | "managed-list" | "token-search" | string
  targetLabel: string
  observedAt: string
  postCount: number
  hitCursor: boolean
  challenged: boolean
  pagesScrolled?: number
  runId?: string
  roundId?: string
  sourceCommit?: string
}>): SourceHealthObservation {
  const sourceKind = args.targetKind === "home"
    ? SOURCE_KIND_X_HOME_FYP
    : args.targetKind === "operator-list"
      ? SOURCE_KIND_X_OPERATOR_LIST
      : args.targetKind === "managed-list"
        ? SOURCE_KIND_X_MANAGED_LIST
        : `x-${args.targetKind}`

  let status: SourceHealthStatus = "unknown"
  let reason: string | undefined

  if (args.challenged) {
    status = "unhealthy"
    reason = "challenge-detected"
  } else if (args.targetKind === "home") {
    if (args.postCount > 0) {
      status = "healthy"
      reason = "posts-present"
    } else if (!args.hitCursor) {
      status = "unhealthy"
      reason = "empty-without-cursor"
    } else {
      status = "healthy"
      reason = "idle-caught-up"
    }
  } else if (args.postCount > 0 || args.hitCursor) {
    status = "healthy"
    reason = args.postCount > 0 ? "posts-present" : "idle-caught-up"
  } else {
    status = "unhealthy"
    reason = "empty-without-cursor"
  }

  return {
    schema: 1,
    observationId: observationId({
      sourceKind,
      target: args.targetLabel,
      observedAt: args.observedAt,
      ...(args.sourceCommit ? { sourceCommit: args.sourceCommit } : {}),
      ...(args.runId ? { runId: args.runId } : {}),
    }),
    sourceKind,
    target: args.targetLabel,
    observedAt: args.observedAt,
    status,
    postCount: args.postCount,
    hitCursor: args.hitCursor,
    challenged: args.challenged,
    ...(args.pagesScrolled !== undefined ? { pagesScrolled: args.pagesScrolled } : {}),
    ...(args.runId ? { runId: args.runId } : {}),
    ...(args.roundId ? { roundId: args.roundId } : {}),
    ...(args.sourceCommit ? { sourceCommit: args.sourceCommit } : {}),
    ...(reason ? { reason } : {}),
  }
}

export function appendSourceHealthObservation(
  ledger: SourceHealthLedger,
  observation: SourceHealthObservation,
): SourceHealthLedger {
  if (ledger.observations.some((o) => o.observationId === observation.observationId)) {
    return ledger
  }
  return {
    schema: 1,
    observations: [...ledger.observations, observation].slice(-4_000),
  }
}

function parseIso(iso: string): number {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : Number.NaN
}

/**
 * Conservative impact window: (last healthy before first unhealthy, recoveryEnd].
 * Missing prior healthy boundary → ok:false (never invent a start).
 */
export function computeImpactWindow(args: Readonly<{
  observations: readonly SourceHealthObservation[]
  sourceKinds: readonly string[]
  recoveryConfirmedAt?: string
}>): ImpactWindow {
  const relevant = args.observations
    .filter((o) => args.sourceKinds.includes(o.sourceKind))
    .slice()
    .sort((a, b) => parseIso(a.observedAt) - parseIso(b.observedAt))

  if (relevant.length === 0) {
    return { schema: 1, ok: false, reason: "no-observations" }
  }

  const firstUnhealthy = relevant.find((o) => o.status === "unhealthy")
  if (!firstUnhealthy) {
    return { schema: 1, ok: false, reason: "no-unhealthy-observation" }
  }

  const firstUnhealthyMs = parseIso(firstUnhealthy.observedAt)
  let lastHealthyBefore: SourceHealthObservation | undefined
  for (const o of relevant) {
    const ms = parseIso(o.observedAt)
    if (o.status === "healthy" && ms < firstUnhealthyMs) {
      lastHealthyBefore = o
    }
  }

  if (!lastHealthyBefore) {
    return { schema: 1, ok: false, reason: "impact-window-unknown" }
  }

  const end = args.recoveryConfirmedAt ?? firstUnhealthy.observedAt
  return {
    schema: 1,
    ok: true,
    startExclusive: lastHealthyBefore.observedAt,
    endInclusive: end,
  }
}

/**
 * Require N distinct healthy observations after deployedAt from the deployed commit.
 * For FYP, healthy already requires posts (or idle-caught-up with cursor).
 */
export function hasPostFixRecoveryProof(args: Readonly<{
  observations: readonly SourceHealthObservation[]
  sourceKinds: readonly string[]
  deployedAt: string
  sourceCommit: string
  requiredHealthy: number
}>): Readonly<{
  ok: boolean
  healthyCount: number
  reason?: string
  recoveryConfirmedAt?: string
}> {
  const deployedMs = parseIso(args.deployedAt)
  if (!Number.isFinite(deployedMs)) {
    return { ok: false, healthyCount: 0, reason: "invalid-deployed-at" }
  }

  const healthy = args.observations
    .filter((o) => args.sourceKinds.includes(o.sourceKind))
    .filter((o) => o.status === "healthy")
    .filter((o) => parseIso(o.observedAt) > deployedMs)
    .filter((o) => o.sourceCommit === args.sourceCommit)
    .filter((o) => {
      if (o.sourceKind === SOURCE_KIND_X_HOME_FYP) {
        return (o.postCount ?? 0) > 0
      }
      return true
    })
    .sort((a, b) => parseIso(a.observedAt) - parseIso(b.observedAt))

  // Distinct by observedAt (separate collection rounds)
  const distinct: SourceHealthObservation[] = []
  const seenAt = new Set<string>()
  for (const o of healthy) {
    if (seenAt.has(o.observedAt)) continue
    seenAt.add(o.observedAt)
    distinct.push(o)
  }

  if (distinct.length < args.requiredHealthy) {
    return {
      ok: false,
      healthyCount: distinct.length,
      reason: `need-${args.requiredHealthy}-healthy-got-${distinct.length}`,
    }
  }

  const last = distinct[args.requiredHealthy - 1]!
  return {
    ok: true,
    healthyCount: distinct.length,
    recoveryConfirmedAt: last.observedAt,
  }
}

/** Source kinds that never appear in the ledger cannot produce recovery proof. */
export function sourceKindsMissingFromLedger(
  observations: readonly SourceHealthObservation[],
  sourceKinds: readonly string[],
): string[] {
  const seen = new Set(observations.map((o) => o.sourceKind))
  return [...sourceKinds].filter((kind) => !seen.has(kind)).sort()
}

export function observationsInWindow(args: Readonly<{
  observations: readonly SourceHealthObservation[]
  startExclusive: string
  endInclusive: string
}>): SourceHealthObservation[] {
  const startMs = parseIso(args.startExclusive)
  const endMs = parseIso(args.endInclusive)
  return args.observations.filter((o) => {
    const ms = parseIso(o.observedAt)
    return ms > startMs && ms <= endMs
  })
}

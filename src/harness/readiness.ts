import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { archiveLayout } from "../lib/archive.js"
import { loadSealedEpoch } from "../orchestrator/scorecard.js"
import { canaryStatus } from "./lifecycle.js"
import { harnessRoot } from "./canary.js"
import { listHypothesisIds, loadHypothesis } from "./propose.js"
import {
  loadHoldoutSubjectsWithSignals,
} from "./signals.js"
import { isHoldoutConsumed } from "./holdout-registry.js"
import {
  listMetaCandidateIds,
  loadMetaCandidate,
  listTrials,
} from "./meta-trial.js"
import type { HarnessCanaryState, HarnessHypothesis } from "../contracts/schemas.js"

export function listSealedEpochIds(archiveRoot: string): string[] {
  const epochsRoot = archiveLayout(archiveRoot).epochs
  if (!existsSync(epochsRoot)) return []
  return readdirSync(epochsRoot)
    .filter((name) => existsSync(join(epochsRoot, name, "sealed", "status.json")))
    .sort()
}

/** Stable skip/reason slugs for schedule reports, skip ledger, and status */
export const HARNESS_READINESS_GATE_IDS = [
  "enabled",
  "schedule-enabled",
  "no-active-canary",
  "no-policy-midflight",
  "no-meta-trialing",
  "sealed-epochs",
  "distinct-epochs",
  "dev-signals",
  "holdout-signals",
  "holdout-unused",
  "dev-sample-floor",
  "holdout-sample-floor",
] as const

export type HarnessReadinessGateId = typeof HARNESS_READINESS_GATE_IDS[number]

export type HarnessReadinessGate = Readonly<{
  id: HarnessReadinessGateId
  ok: boolean
  reason?: string
  details?: Readonly<Record<string, string | number | boolean>>
}>

export type HarnessImproveReadiness = Readonly<{
  ready: boolean
  reason?: string
  reasonSlug?: string
  nextAction?: string
  gates: readonly HarnessReadinessGate[]
  sealedEpochIds: readonly string[]
  developmentEpochId?: string
  holdoutEpochId?: string
}>

export type HarnessImproveConfigSlice = Readonly<{
  enabled: boolean
  schedule_enabled: boolean
  require_two_epochs: boolean
  one_active_experiment: boolean
  min_events: number
  min_holdout_events: number
}>

/** Policy statuses that block a second concurrent policy experiment */
export const POLICY_MIDFLIGHT_STATUSES = new Set([
  "plan_approved",
  "prepared",
  "built",
  "static_validated",
  "holdout_evaluated",
  "implementation_approved",
  "committed",
  "integrated",
  "runtime_deployed",
  "activation_pending",
  "evaluated",
  "canary",
])

export function policyHypothesisMidFlight(archiveRoot: string): string | undefined {
  for (const id of listHypothesisIds(archiveRoot)) {
    try {
      const hyp = loadHypothesis(archiveRoot, id)
      if (POLICY_MIDFLIGHT_STATUSES.has(hyp.status)) return id
    } catch {
      // skip non-hypothesis dirs / corrupt
    }
  }
  return undefined
}

export function activeTrialingMetaCandidate(archiveRoot: string): string | undefined {
  for (const id of listMetaCandidateIds(archiveRoot)) {
    try {
      const c = loadMetaCandidate(archiveRoot, id)
      if (c.status === "trialing") return id
    } catch {
      // skip
    }
  }
  return undefined
}

export function epochsUsedByMeta(archiveRoot: string): Set<string> {
  const used = new Set<string>()
  for (const id of listMetaCandidateIds(archiveRoot)) {
    for (const trial of listTrials(archiveRoot, id)) {
      used.add(trial.developmentEpochId)
      used.add(trial.holdoutEpochId)
    }
  }
  return used
}

export function findActivationPendingHypothesis(
  archiveRoot: string,
): HarnessHypothesis | undefined {
  for (const id of listHypothesisIds(archiveRoot)) {
    try {
      const hyp = loadHypothesis(archiveRoot, id)
      if (hyp.status === "activation_pending") return hyp
    } catch {
      // skip
    }
  }
  return undefined
}

function gate(
  id: HarnessReadinessGateId,
  ok: boolean,
  reason?: string,
  details?: Readonly<Record<string, string | number | boolean>>,
): HarnessReadinessGate {
  return {
    id,
    ok,
    ...(reason ? { reason } : {}),
    ...(details ? { details } : {}),
  }
}

function firstFailure(gates: readonly HarnessReadinessGate[]): HarnessReadinessGate | undefined {
  return gates.find((g) => !g.ok)
}

function nextActionFor(
  failed: HarnessReadinessGate | undefined,
  opts: Readonly<{
    pendingActivation?: string
    developmentEpochId?: string
    holdoutEpochId?: string
  }>,
): string {
  if (opts.pendingActivation) {
    return `tc harness activate ${opts.pendingActivation}`
  }
  if (!failed) return "tc harness run"
  switch (failed.id) {
    case "enabled":
      return "set harness_improvement.enabled=true"
    case "schedule-enabled":
      return "set harness_improvement.schedule_enabled=true"
    case "no-active-canary":
      return "wait for canary maturity/rollback or tc harness canary stop"
    case "no-policy-midflight":
      return `wait for policy hypothesis ${String(failed.details?.["hypothesisId"] ?? "")} to finish`
    case "no-meta-trialing":
      return `wait for meta candidate ${String(failed.details?.["candidateId"] ?? "")} or reject it`
    case "sealed-epochs":
      return "wait for a sealed audit epoch with decision-time signals"
    case "distinct-epochs":
      return "wait for a second distinct sealed audit epoch"
    case "dev-signals":
    case "holdout-signals":
      return "wait for sealed epochs whose subjects archive decision-time signals"
    case "holdout-unused":
      return "wait for an unused holdout sealed epoch"
    case "dev-sample-floor":
      return "wait for a development epoch meeting min_events"
    case "holdout-sample-floor":
      return "wait for a holdout epoch meeting min_holdout_events"
    default:
      return "tc harness status"
  }
}

/**
 * Read-only policy-lane readiness. Necessary, not sufficient: never acquires
 * locks, creates hypotheses, replays, consumes holdouts, or runs agents.
 */
export function assessHarnessImproveReadiness(opts: Readonly<{
  archiveRoot: string
  config: HarnessImproveConfigSlice
  developmentEpochId?: string
  holdoutEpochId?: string
}>): HarnessImproveReadiness {
  const gates: HarnessReadinessGate[] = []
  const sealedEpochIds = listSealedEpochIds(opts.archiveRoot)
  const layout = archiveLayout(opts.archiveRoot)

  gates.push(gate(
    "enabled",
    opts.config.enabled,
    opts.config.enabled ? undefined : "harness_improvement.enabled is false",
  ))
  gates.push(gate(
    "schedule-enabled",
    opts.config.schedule_enabled,
    opts.config.schedule_enabled
      ? undefined
      : "harness_improvement.schedule_enabled is false",
  ))

  if (opts.config.one_active_experiment) {
    const status = canaryStatus(opts.archiveRoot)
    const canaryActive = Boolean(status.active?.active)
    gates.push(gate(
      "no-active-canary",
      !canaryActive,
      canaryActive ? `active canary ${status.active!.hypothesisId}` : undefined,
      canaryActive ? { hypothesisId: status.active!.hypothesisId } : undefined,
    ))

    const mid = policyHypothesisMidFlight(opts.archiveRoot)
    gates.push(gate(
      "no-policy-midflight",
      !mid,
      mid ? `policy hypothesis mid-flight ${mid}` : undefined,
      mid ? { hypothesisId: mid } : undefined,
    ))

    const trialing = activeTrialingMetaCandidate(opts.archiveRoot)
    gates.push(gate(
      "no-meta-trialing",
      !trialing,
      trialing ? `meta candidate already trialing ${trialing}` : undefined,
      trialing ? { candidateId: trialing } : undefined,
    ))
  } else {
    gates.push(gate("no-active-canary", true))
    gates.push(gate("no-policy-midflight", true))
    gates.push(gate("no-meta-trialing", true))
  }

  const developmentEpochId = opts.developmentEpochId
    ?? sealedEpochIds.at(-2)
    ?? sealedEpochIds.at(-1)
  const holdoutEpochId = opts.holdoutEpochId ?? sealedEpochIds.at(-1)

  gates.push(gate(
    "sealed-epochs",
    Boolean(developmentEpochId && holdoutEpochId),
    developmentEpochId && holdoutEpochId
      ? undefined
      : "need at least one sealed epoch",
  ))

  const distinctOk = !opts.config.require_two_epochs
    || (
      Boolean(developmentEpochId)
      && Boolean(holdoutEpochId)
      && developmentEpochId !== holdoutEpochId
    )
  gates.push(gate(
    "distinct-epochs",
    distinctOk,
    distinctOk
      ? undefined
      : "require_two_epochs: need distinct development and holdout sealed epochs",
    developmentEpochId && holdoutEpochId
      ? { developmentEpochId, holdoutEpochId }
      : undefined,
  ))

  let devSignalsOk = false
  let holdoutSignalsOk = false
  let holdoutSubjects = 0
  if (developmentEpochId) {
    try {
      const sealed = loadSealedEpoch(layout, developmentEpochId)
      const loaded = loadHoldoutSubjectsWithSignals(layout, sealed)
      devSignalsOk = loaded.ok
      gates.push(gate(
        "dev-signals",
        loaded.ok,
        loaded.ok
          ? undefined
          : `development epoch ${developmentEpochId} lacks decision-time signals`,
        { developmentEpochId },
      ))
      if (loaded.ok) {
        const denom = sealed.scorecard.outcomeCoverage.denominator
        const sampleOk = denom >= opts.config.min_events
        gates.push(gate(
          "dev-sample-floor",
          sampleOk,
          sampleOk
            ? undefined
            : `development epoch ${developmentEpochId} below min_events (${denom}<${opts.config.min_events})`,
          {
            developmentEpochId,
            denominator: denom,
            minEvents: opts.config.min_events,
          },
        ))
      } else {
        gates.push(gate("dev-sample-floor", false, "development sample unavailable", {
          developmentEpochId,
        }))
      }
    } catch {
      gates.push(gate(
        "dev-signals",
        false,
        `development epoch ${developmentEpochId} lacks decision-time signals`,
        { developmentEpochId },
      ))
      gates.push(gate("dev-sample-floor", false, "development sample unavailable", {
        developmentEpochId,
      }))
    }
  } else {
    gates.push(gate("dev-signals", false, "need at least one sealed epoch"))
    gates.push(gate("dev-sample-floor", false, "need at least one sealed epoch"))
  }

  if (holdoutEpochId) {
    try {
      const sealed = loadSealedEpoch(layout, holdoutEpochId)
      const loaded = loadHoldoutSubjectsWithSignals(layout, sealed)
      holdoutSignalsOk = loaded.ok
      holdoutSubjects = loaded.ok ? loaded.subjects.length : 0
      gates.push(gate(
        "holdout-signals",
        loaded.ok,
        loaded.ok
          ? undefined
          : `holdout epoch ${holdoutEpochId} lacks decision-time signals`,
        { holdoutEpochId },
      ))
      const unused = !isHoldoutConsumed(opts.archiveRoot, holdoutEpochId)
      gates.push(gate(
        "holdout-unused",
        unused,
        unused ? undefined : `holdout ${holdoutEpochId} already consumed`,
        { holdoutEpochId },
      ))
      const sampleOk = holdoutSubjects >= opts.config.min_holdout_events
      gates.push(gate(
        "holdout-sample-floor",
        loaded.ok && sampleOk,
        !loaded.ok
          ? "holdout sample unavailable"
          : sampleOk
            ? undefined
            : `holdout epoch ${holdoutEpochId} below min_holdout_events (${holdoutSubjects}<${opts.config.min_holdout_events})`,
        {
          holdoutEpochId,
          subjects: holdoutSubjects,
          minHoldoutEvents: opts.config.min_holdout_events,
        },
      ))
    } catch {
      gates.push(gate(
        "holdout-signals",
        false,
        `holdout epoch ${holdoutEpochId} lacks decision-time signals`,
        { holdoutEpochId },
      ))
      gates.push(gate(
        "holdout-unused",
        !isHoldoutConsumed(opts.archiveRoot, holdoutEpochId),
        isHoldoutConsumed(opts.archiveRoot, holdoutEpochId)
          ? `holdout ${holdoutEpochId} already consumed`
          : undefined,
        { holdoutEpochId },
      ))
      gates.push(gate("holdout-sample-floor", false, "holdout sample unavailable", {
        holdoutEpochId,
      }))
    }
  } else {
    gates.push(gate("holdout-signals", false, "need at least one sealed epoch"))
    gates.push(gate("holdout-unused", false, "need at least one sealed epoch"))
    gates.push(gate("holdout-sample-floor", false, "need at least one sealed epoch"))
  }

  void devSignalsOk
  void holdoutSignalsOk

  const failed = firstFailure(gates)
  const pending = findActivationPendingHypothesis(opts.archiveRoot)
  const nextAction = nextActionFor(failed, {
    ...(pending ? { pendingActivation: pending.hypothesisId } : {}),
    ...(developmentEpochId ? { developmentEpochId } : {}),
    ...(holdoutEpochId ? { holdoutEpochId } : {}),
  })

  return {
    ready: !failed,
    ...(failed?.reason ? { reason: failed.reason } : {}),
    ...(failed ? { reasonSlug: failed.id } : {}),
    nextAction,
    gates,
    sealedEpochIds,
    ...(developmentEpochId ? { developmentEpochId } : {}),
    ...(holdoutEpochId ? { holdoutEpochId } : {}),
  }
}

export type HarnessScheduleReportPersisted = Readonly<{
  at: string
  status: string
  reason?: string
  reasonSlug?: string
  nextAction?: string
  hypothesisId?: string
  developmentEpochId?: string
  holdoutEpochId?: string
  gates?: readonly HarnessReadinessGate[]
}>

export function loadHarnessScheduleReport(
  archiveRoot: string,
): HarnessScheduleReportPersisted | undefined {
  const path = join(harnessRoot(archiveRoot), "schedule-report.json")
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf8")) as HarnessScheduleReportPersisted
  } catch {
    return undefined
  }
}

export type HarnessStatusSnapshot = Readonly<{
  canary?: HarnessCanaryState
  hypotheses: readonly string[]
  readiness: HarnessImproveReadiness
  lastRun?: HarnessScheduleReportPersisted
  pendingActivation?: Readonly<{
    hypothesisId: string
    status: string
  }>
  nextAction: string
}>

export function harnessStatusSnapshot(opts: Readonly<{
  archiveRoot: string
  config: HarnessImproveConfigSlice
}>): HarnessStatusSnapshot {
  const canary = canaryStatus(opts.archiveRoot)
  const readiness = assessHarnessImproveReadiness({
    archiveRoot: opts.archiveRoot,
    config: opts.config,
  })
  const lastRun = loadHarnessScheduleReport(opts.archiveRoot)
  const pending = findActivationPendingHypothesis(opts.archiveRoot)
  const nextAction = pending
    ? `tc harness activate ${pending.hypothesisId}`
    : (lastRun?.nextAction ?? readiness.nextAction ?? "tc harness status")

  return {
    ...(canary.active ? { canary: canary.active } : {}),
    hypotheses: canary.hypotheses,
    readiness,
    ...(lastRun ? { lastRun } : {}),
    ...(pending
      ? {
        pendingActivation: {
          hypothesisId: pending.hypothesisId,
          status: pending.status,
        },
      }
      : {}),
    nextAction,
  }
}

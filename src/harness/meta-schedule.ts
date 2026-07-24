import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "../lib/config.js"
import { systemClock } from "../lib/clock.js"
import { ensureArchive, archiveLayout } from "../lib/archive.js"
import { WorkspaceLock } from "../lib/lock.js"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { log } from "../lib/log.js"
import { harnessRoot } from "./canary.js"
import { canaryStatus } from "./lifecycle.js"
import { listHypothesisIds, loadHypothesis } from "./propose.js"
import {
  epochHasDecisionSignals,
} from "./signals.js"
import { isHoldoutConsumed } from "./holdout-registry.js"
import { assertRepoRoot } from "./pr.js"
import {
  proposeMetaCandidateFromPrior,
  setMetaCandidateStatus,
} from "./meta-propose.js"
import {
  listMetaCandidateIds,
  listTrials,
  loadMetaCandidate,
  metaRoot,
  recomputeAndSaveUtility,
  runMetaTrialPair,
} from "./meta-trial.js"
import { notifyMetaPromotionEligible } from "./meta-operator-notify.js"

export type HarnessMetaImproveReport = Readonly<{
  status:
    | "skipped"
    | "proposed"
    | "trialed"
    | "promotion_eligible"
    | "rejected"
    | "failed"
  reason?: string
  candidateId?: string
  trialId?: string
  developmentEpochId?: string
  holdoutEpochId?: string
  promotionEligible?: boolean
}>

const POLICY_MIDFLIGHT = new Set([
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

function harnessLockPath(archiveRoot: string): string {
  return join(harnessRoot(archiveRoot), ".lock")
}

function listSealedEpochIds(archiveRoot: string): string[] {
  const epochsRoot = archiveLayout(archiveRoot).epochs
  if (!existsSync(epochsRoot)) return []
  return readdirSync(epochsRoot)
    .filter((name) => existsSync(join(epochsRoot, name, "sealed", "status.json")))
    .sort()
}

function policyHypothesisMidFlight(archiveRoot: string): string | undefined {
  for (const id of listHypothesisIds(archiveRoot)) {
    try {
      const hyp = loadHypothesis(archiveRoot, id)
      if (POLICY_MIDFLIGHT.has(hyp.status)) return id
    } catch {
      // skip non-hypothesis dirs / corrupt
    }
  }
  return undefined
}

function activeTrialingMetaCandidate(archiveRoot: string): string | undefined {
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

function epochsUsedByMeta(archiveRoot: string): Set<string> {
  const used = new Set<string>()
  for (const id of listMetaCandidateIds(archiveRoot)) {
    for (const trial of listTrials(archiveRoot, id)) {
      used.add(trial.developmentEpochId)
      used.add(trial.holdoutEpochId)
    }
  }
  return used
}

export function pickUnusedMetaEpochPair(opts: Readonly<{
  archiveRoot: string
  developmentEpochId?: string
  holdoutEpochId?: string
  requireTwoEpochs?: boolean
}>): Readonly<{
  ok: true
  developmentEpochId: string
  holdoutEpochId: string
} | {
  ok: false
  reason: string
}> {
  const layout = archiveLayout(opts.archiveRoot)
  const used = epochsUsedByMeta(opts.archiveRoot)
  const sealed = listSealedEpochIds(opts.archiveRoot).filter((id) => {
    if (used.has(id)) return false
    if (isHoldoutConsumed(opts.archiveRoot, id)) return false
    return epochHasDecisionSignals(layout, id)
  })

  const developmentEpochId = opts.developmentEpochId
    ?? sealed.at(-2)
    ?? sealed.at(-1)
  const holdoutEpochId = opts.holdoutEpochId ?? sealed.at(-1)

  if (!developmentEpochId || !holdoutEpochId) {
    return { ok: false, reason: "need at least one sealed epoch with unused signals" }
  }
  if (
    (opts.requireTwoEpochs !== false)
    && developmentEpochId === holdoutEpochId
  ) {
    return {
      ok: false,
      reason: "require_two_epochs: need distinct development and holdout sealed epochs",
    }
  }
  if (isHoldoutConsumed(opts.archiveRoot, holdoutEpochId)) {
    return { ok: false, reason: `holdout ${holdoutEpochId} already consumed` }
  }
  if (!epochHasDecisionSignals(layout, developmentEpochId)) {
    return {
      ok: false,
      reason: `development epoch ${developmentEpochId} lacks decision-time signals`,
    }
  }
  if (!epochHasDecisionSignals(layout, holdoutEpochId)) {
    return {
      ok: false,
      reason: `holdout epoch ${holdoutEpochId} lacks decision-time signals`,
    }
  }
  return { ok: true, developmentEpochId, holdoutEpochId }
}

async function persistMetaScheduleReport(
  archiveRoot: string,
  report: HarnessMetaImproveReport,
  nowIso: string,
): Promise<void> {
  await writeAtomicFile(
    join(metaRoot(archiveRoot), "schedule-report.json"),
    `${JSON.stringify({ at: nowIso, ...report }, null, 2)}\n`,
  )
}

export type RunHarnessMetaImproveOptions = Readonly<{
  archiveRoot: string
  repoRoot: string
  nowIso?: string
  developmentEpochId?: string
  holdoutEpochId?: string
  candidateId?: string
  /** Bypass schedule_days cadence check */
  force?: boolean
}>

/**
 * Shadow meta improver schedule (ADR 039).
 * Proposes / trials one paired offline experiment. Never integrates, deploys,
 * or activates.
 */
export async function runHarnessMetaImprove(
  opts: RunHarnessMetaImproveOptions,
): Promise<HarnessMetaImproveReport> {
  const config = loadConfig()
  const hi = config.harness_improvement
  if (!hi.meta_enabled) {
    return { status: "skipped", reason: "harness_improvement.meta_enabled is false" }
  }
  if (!hi.meta_schedule_enabled) {
    return {
      status: "skipped",
      reason: "harness_improvement.meta_schedule_enabled is false",
    }
  }

  const lock = new WorkspaceLock(harnessLockPath(opts.archiveRoot))
  if (!lock.tryAcquire()) {
    return { status: "skipped", reason: "harness lock held" }
  }

  try {
    await ensureArchive(opts.archiveRoot)
    assertRepoRoot(opts.repoRoot)
    const nowIso = opts.nowIso ?? systemClock.nowIso()

    if (hi.one_active_experiment) {
      const status = canaryStatus(opts.archiveRoot)
      if (status.active?.active) {
        const report: HarnessMetaImproveReport = {
          status: "skipped",
          reason: `active canary ${status.active.hypothesisId}`,
        }
        await persistMetaScheduleReport(opts.archiveRoot, report, nowIso)
        return report
      }
      const mid = policyHypothesisMidFlight(opts.archiveRoot)
      if (mid) {
        const report: HarnessMetaImproveReport = {
          status: "skipped",
          reason: `policy hypothesis mid-flight ${mid}`,
        }
        await persistMetaScheduleReport(opts.archiveRoot, report, nowIso)
        return report
      }
      const trialing = activeTrialingMetaCandidate(opts.archiveRoot)
      if (trialing && trialing !== opts.candidateId) {
        const report: HarnessMetaImproveReport = {
          status: "skipped",
          reason: `meta candidate already trialing ${trialing}`,
          candidateId: trialing,
        }
        await persistMetaScheduleReport(opts.archiveRoot, report, nowIso)
        return report
      }
    }

    const pairPick = pickUnusedMetaEpochPair({
      archiveRoot: opts.archiveRoot,
      ...(opts.developmentEpochId
        ? { developmentEpochId: opts.developmentEpochId }
        : {}),
      ...(opts.holdoutEpochId ? { holdoutEpochId: opts.holdoutEpochId } : {}),
      requireTwoEpochs: hi.require_two_epochs,
    })
    if (!pairPick.ok) {
      const report: HarnessMetaImproveReport = {
        status: "skipped",
        reason: pairPick.reason,
      }
      await persistMetaScheduleReport(opts.archiveRoot, report, nowIso)
      return report
    }
    const { developmentEpochId, holdoutEpochId } = pairPick

    let candidateId = opts.candidateId
    if (!candidateId) {
      const open = listMetaCandidateIds(opts.archiveRoot).find((id) => {
        try {
          const c = loadMetaCandidate(opts.archiveRoot, id)
          return c.status === "proposed" || c.status === "trialing"
        } catch {
          return false
        }
      })
      if (open) {
        candidateId = open
      } else {
        const proposed = await proposeMetaCandidateFromPrior({
          archiveRoot: opts.archiveRoot,
          repoRoot: opts.repoRoot,
          nowIso,
        })
        candidateId = proposed.candidateId
      }
    }

    await setMetaCandidateStatus({
      archiveRoot: opts.archiveRoot,
      candidateId,
      status: "trialing",
    })

    let trial
    try {
      trial = await runMetaTrialPair({
        archiveRoot: opts.archiveRoot,
        repoRoot: opts.repoRoot,
        candidateId,
        developmentEpochId,
        holdoutEpochId,
        nowIso,
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const report: HarnessMetaImproveReport = {
        status: "failed",
        reason: detail.slice(0, 500),
        candidateId,
        developmentEpochId,
        holdoutEpochId,
      }
      await persistMetaScheduleReport(opts.archiveRoot, report, nowIso)
      return report
    }

    const utility = await recomputeAndSaveUtility({
      archiveRoot: opts.archiveRoot,
      candidateId,
      nowIso,
    })

    if (utility.promotionEligible) {
      const eligible = await setMetaCandidateStatus({
        archiveRoot: opts.archiveRoot,
        candidateId,
        status: "promotion_eligible",
      })
      await notifyMetaPromotionEligible({
        archiveRoot: opts.archiveRoot,
        candidate: eligible,
        utility,
        nowIso,
      })
      const report: HarnessMetaImproveReport = {
        status: "promotion_eligible",
        candidateId,
        trialId: trial.trialId,
        developmentEpochId,
        holdoutEpochId,
        promotionEligible: true,
      }
      await persistMetaScheduleReport(opts.archiveRoot, report, nowIso)
      log.info("harness-meta-improve promotion_eligible", report as never)
      return report
    }

    const report: HarnessMetaImproveReport = {
      status: "trialed",
      candidateId,
      trialId: trial.trialId,
      developmentEpochId,
      holdoutEpochId,
      promotionEligible: false,
      ...(utility.rejectReason ? { reason: utility.rejectReason } : {}),
    }
    await persistMetaScheduleReport(opts.archiveRoot, report, nowIso)
    log.info("harness-meta-improve trialed", report as never)
    return report
  } finally {
    lock.release()
  }
}

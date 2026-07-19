import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { loadConfig } from "../lib/config.js"
import { systemClock } from "../lib/clock.js"
import { sha256Json } from "../lib/canonical-json.js"
import { writeAtomicFile, sha256Bytes } from "../lib/fs-atomic.js"
import { archiveLayout, ensureArchive } from "../lib/archive.js"
import { WorkspaceLock } from "../lib/lock.js"
import { log } from "../lib/log.js"
import {
  proposeFromSealedEpoch,
  loadHypothesis,
  saveHypothesis,
  hypothesisDir,
} from "./propose.js"
import {
  prepareWorktree,
  evaluateWorktreeConfinement,
  readWorktreeMeta,
} from "./prepare.js"
import {
  advanceHarnessJournal,
  canaryStatus,
  writeRejectionReceipt,
} from "./lifecycle.js"
import { harnessRoot } from "./canary.js"
import { assertRepoRoot, defaultExec, type ExecFn } from "./pr.js"
import { runHarnessPlanner, type PlanSessionFn } from "./plan-agent.js"
import { runHarnessReview, validateReviewApproval } from "./review-agent.js"
import { runHarnessBuilder } from "./build-agent.js"
import { evaluateHypothesis } from "./evaluate.js"
import {
  epochHasDecisionSignals,
  loadHoldoutSubjectsWithSignalsOrThrow,
} from "./signals.js"
import { loadPolicy } from "./policy.js"
import { commitCandidateBranch, fastForwardLocalMain } from "./integrate.js"
import { deployRuntimeFromRepo } from "./deploy.js"
import { writePendingAgentDeploymentManifest } from "./drain.js"
import { DECISION_POLICY_REL_PATH, POLICY_ALLOWLIST } from "./paths.js"
import type { HarnessPlan } from "../contracts/schemas.js"
import type { SessionOptions, SessionResult } from "../orchestrator/session.js"

export type HarnessImproveReport = Readonly<{
  status:
    | "skipped"
    | "activation_pending"
    | "evaluated_no_deploy"
    | "rejected"
    | "failed"
    | "integrated_deployed"
  reason?: string
  hypothesisId?: string
  developmentEpochId?: string
  holdoutEpochId?: string
  branch?: string
  confinementOk?: boolean
  testsOk?: boolean
  baseCommit?: string
  candidateCommit?: string
}>

export type HarnessSessionFn = (opts: SessionOptions) => Promise<SessionResult>

function listSealedEpochIds(archiveRoot: string): string[] {
  const epochsRoot = archiveLayout(archiveRoot).epochs
  if (!existsSync(epochsRoot)) return []
  return readdirSync(epochsRoot)
    .filter((name) => existsSync(join(epochsRoot, name, "sealed", "status.json")))
    .sort()
}

function harnessLockPath(archiveRoot: string): string {
  return join(harnessRoot(archiveRoot), ".lock")
}

function gitRevParse(repoRoot: string): string {
  const out = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  const sha = (out.stdout ?? "").trim()
  if (out.status !== 0 || sha.length < 7) {
    throw new Error(`git rev-parse HEAD failed in ${repoRoot}`)
  }
  return sha
}

function hostValidatePlan(
  plan: HarnessPlan,
  primaryMetric: string,
  allowlistPaths: readonly string[],
): { ok: true } | { ok: false, reason: string } {
  if (plan.primaryMetric !== primaryMetric) {
    return { ok: false, reason: "plan primaryMetric mismatch vs hypothesis" }
  }
  const allowOk = allowlistPaths.length === 1
    && allowlistPaths[0] === DECISION_POLICY_REL_PATH
  if (!allowOk) {
    return { ok: false, reason: "hypothesis allowlist must be decision-policy only" }
  }
  if (plan.proposedPolicyDocument) {
    const paths = plan.proposedPolicyDocument.allowlistPaths
    if (paths.length > 0 && paths.some((p) => p !== DECISION_POLICY_REL_PATH)) {
      return { ok: false, reason: "plan policy allowlist expanded beyond decision-policy" }
    }
  }
  if (!plan.currentPolicyHash || !plan.scorecardSummaryHash) {
    return { ok: false, reason: "plan missing required hashes" }
  }
  return { ok: true }
}

async function persistScheduleReport(
  archiveRoot: string,
  hypothesisId: string,
  report: HarnessImproveReport,
): Promise<void> {
  await writeAtomicFile(
    join(hypothesisDir(archiveRoot, hypothesisId), "schedule-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  )
}

export type RunHarnessImproveOptions = Readonly<{
  archiveRoot: string
  repoRoot: string
  nowIso?: string
  developmentEpochId?: string
  holdoutEpochId?: string
  dryRun?: boolean
  runTests?: boolean
  skipDeploy?: boolean
  exec?: ExecFn
  /** Injectable session runner for planner, reviewer, and builder */
  runSession?: HarnessSessionFn
}>

/**
 * Agent-gated scheduled pipeline: sealed epochs → plan/review/build →
 * holdout evaluate → local main integrate → runtime deploy → activation pending.
 * Never activates the agent workspace. Never starts canary.
 */
export async function runHarnessImprove(
  opts: RunHarnessImproveOptions,
): Promise<HarnessImproveReport> {
  const config = loadConfig()
  const hi = config.harness_improvement
  if (!hi.enabled) {
    return { status: "skipped", reason: "harness_improvement.enabled is false" }
  }
  if (!hi.schedule_enabled) {
    return { status: "skipped", reason: "harness_improvement.schedule_enabled is false" }
  }

  const lock = new WorkspaceLock(harnessLockPath(opts.archiveRoot))
  if (!lock.tryAcquire()) {
    return { status: "skipped", reason: "harness lock held" }
  }

  try {
    await ensureArchive(opts.archiveRoot)
    assertRepoRoot(opts.repoRoot)
    const nowIso = opts.nowIso ?? systemClock.nowIso()
    const exec = opts.exec ?? defaultExec
    const layout = archiveLayout(opts.archiveRoot)
    const runSession = opts.runSession as PlanSessionFn | undefined

    if (hi.one_active_experiment) {
      const status = canaryStatus(opts.archiveRoot)
      if (status.active?.active) {
        return {
          status: "skipped",
          reason: `active canary ${status.active.hypothesisId}`,
        }
      }
    }

    const sealed = listSealedEpochIds(opts.archiveRoot)
    const developmentEpochId = opts.developmentEpochId
      ?? sealed.at(-2)
      ?? sealed.at(-1)
    const holdoutEpochId = opts.holdoutEpochId ?? sealed.at(-1)

    if (!developmentEpochId || !holdoutEpochId) {
      return { status: "skipped", reason: "need at least one sealed epoch" }
    }
    if (hi.require_two_epochs && developmentEpochId === holdoutEpochId) {
      return {
        status: "skipped",
        reason: "require_two_epochs: need distinct development and holdout sealed epochs",
        developmentEpochId,
        holdoutEpochId,
      }
    }
    if (!epochHasDecisionSignals(layout, developmentEpochId)) {
      return {
        status: "skipped",
        reason: `development epoch ${developmentEpochId} lacks decision-time signals`,
        developmentEpochId,
        holdoutEpochId,
      }
    }
    if (!epochHasDecisionSignals(layout, holdoutEpochId)) {
      return {
        status: "skipped",
        reason: `holdout epoch ${holdoutEpochId} lacks decision-time signals`,
        developmentEpochId,
        holdoutEpochId,
      }
    }

    const hypothesis = await proposeFromSealedEpoch({
      archiveRoot: opts.archiveRoot,
      epochId: developmentEpochId,
      nowIso,
      minEvents: hi.min_events,
      minHoldoutEvents: hi.min_holdout_events,
    })
    // Do not advance journal to "proposed" — phase removed

    const baseCommit = gitRevParse(opts.repoRoot)
    const planned = await runHarnessPlanner({
      archiveRoot: opts.archiveRoot,
      hypothesisId: hypothesis.hypothesisId,
      repoRoot: opts.repoRoot,
      model: hi.planner_model,
      baseCommit,
      developmentEpochId,
      holdoutEpochId,
      nowIso,
      ...(runSession ? { runSession } : {}),
    })
    if (!planned.ok) {
      await writeRejectionReceipt(opts.archiveRoot, {
        schema: 1,
        hypothesisId: hypothesis.hypothesisId,
        rejectedAt: nowIso,
        phase: "planned",
        reason: planned.reason.slice(0, 500),
      })
      const report: HarnessImproveReport = {
        status: "rejected",
        reason: planned.reason,
        hypothesisId: hypothesis.hypothesisId,
        developmentEpochId,
        holdoutEpochId,
        baseCommit,
      }
      await persistScheduleReport(opts.archiveRoot, hypothesis.hypothesisId, report)
      return report
    }
    await advanceHarnessJournal(
      opts.archiveRoot,
      hypothesis.hypothesisId,
      "planned",
      planned.planHash,
    )

    const planGate = hostValidatePlan(
      planned.plan,
      hypothesis.primaryMetric,
      hypothesis.allowlistPaths,
    )
    if (!planGate.ok) {
      await writeRejectionReceipt(opts.archiveRoot, {
        schema: 1,
        hypothesisId: hypothesis.hypothesisId,
        rejectedAt: nowIso,
        phase: "plan_validated",
        reason: planGate.reason,
        planHash: planned.planHash,
      })
      const report: HarnessImproveReport = {
        status: "rejected",
        reason: planGate.reason,
        hypothesisId: hypothesis.hypothesisId,
        developmentEpochId,
        holdoutEpochId,
        baseCommit,
      }
      await persistScheduleReport(opts.archiveRoot, hypothesis.hypothesisId, report)
      return report
    }
    await saveHypothesis(opts.archiveRoot, {
      ...loadHypothesis(opts.archiveRoot, hypothesis.hypothesisId),
      status: "plan_validated",
    })
    await advanceHarnessJournal(
      opts.archiveRoot,
      hypothesis.hypothesisId,
      "plan_validated",
      sha256Json({ planHash: planned.planHash, gate: "ok" } as never),
    )

    const planReview = await runHarnessReview({
      archiveRoot: opts.archiveRoot,
      hypothesisId: hypothesis.hypothesisId,
      repoRoot: opts.repoRoot,
      phase: "plan",
      model: hi.reviewer_model,
      nowIso,
      artifactPaths: [
        join(hypothesisDir(opts.archiveRoot, hypothesis.hypothesisId), "plan.json"),
      ],
      planHash: planned.planHash,
      ...(runSession ? { runSession } : {}),
    })
    if (!planReview.ok) {
      await writeRejectionReceipt(opts.archiveRoot, {
        schema: 1,
        hypothesisId: hypothesis.hypothesisId,
        rejectedAt: nowIso,
        phase: "plan_approved",
        reason: planReview.reason.slice(0, 500),
        planHash: planned.planHash,
      })
      const report: HarnessImproveReport = {
        status: "rejected",
        reason: planReview.reason,
        hypothesisId: hypothesis.hypothesisId,
        developmentEpochId,
        holdoutEpochId,
        baseCommit,
      }
      await persistScheduleReport(opts.archiveRoot, hypothesis.hypothesisId, report)
      return report
    }
    const planApproval = validateReviewApproval(planReview.review)
    if (!planApproval.ok) {
      await writeRejectionReceipt(opts.archiveRoot, {
        schema: 1,
        hypothesisId: hypothesis.hypothesisId,
        rejectedAt: nowIso,
        phase: "plan_approved",
        reason: planApproval.reason,
        planHash: planned.planHash,
        reviewHash: planReview.reviewHash,
      })
      const report: HarnessImproveReport = {
        status: "rejected",
        reason: planApproval.reason,
        hypothesisId: hypothesis.hypothesisId,
        developmentEpochId,
        holdoutEpochId,
        baseCommit,
      }
      await persistScheduleReport(opts.archiveRoot, hypothesis.hypothesisId, report)
      return report
    }
    await saveHypothesis(opts.archiveRoot, {
      ...loadHypothesis(opts.archiveRoot, hypothesis.hypothesisId),
      status: "plan_approved",
    })
    await advanceHarnessJournal(
      opts.archiveRoot,
      hypothesis.hypothesisId,
      "plan_approved",
      planReview.reviewHash,
    )

    const prepared = await prepareWorktree({
      archiveRoot: opts.archiveRoot,
      hypothesisId: hypothesis.hypothesisId,
      repoRoot: opts.repoRoot,
      nowIso,
    })
    await advanceHarnessJournal(
      opts.archiveRoot,
      hypothesis.hypothesisId,
      "prepared",
      sha256Json({ worktreePath: prepared.worktreePath } as never),
    )

    const built = await runHarnessBuilder({
      archiveRoot: opts.archiveRoot,
      hypothesisId: hypothesis.hypothesisId,
      repoRoot: opts.repoRoot,
      model: hi.builder_model,
      nowIso,
      runTests: false,
      ...(runSession ? { runSession } : {}),
    })
    if (!built.ok) {
      await writeRejectionReceipt(opts.archiveRoot, {
        schema: 1,
        hypothesisId: hypothesis.hypothesisId,
        rejectedAt: nowIso,
        phase: "built",
        reason: built.reason.slice(0, 500),
      })
      const report: HarnessImproveReport = {
        status: "rejected",
        reason: built.reason,
        hypothesisId: hypothesis.hypothesisId,
        developmentEpochId,
        holdoutEpochId,
        branch: prepared.branch,
        baseCommit,
      }
      await persistScheduleReport(opts.archiveRoot, hypothesis.hypothesisId, report)
      return report
    }
    await advanceHarnessJournal(
      opts.archiveRoot,
      hypothesis.hypothesisId,
      "built",
      sha256Json({ policyVersion: built.policy.policyVersion } as never),
    )

    const confinement = evaluateWorktreeConfinement({
      worktreePath: prepared.worktreePath,
      allowlist: [...POLICY_ALLOWLIST],
      repoRoot: opts.repoRoot,
    })
    if (!confinement.ok) {
      await writeRejectionReceipt(opts.archiveRoot, {
        schema: 1,
        hypothesisId: hypothesis.hypothesisId,
        rejectedAt: nowIso,
        phase: "static_validated",
        reason: `confinement: ${confinement.violations.join(",")}`.slice(0, 500),
      })
      const report: HarnessImproveReport = {
        status: "rejected",
        reason: `confinement: ${confinement.violations.join(",")}`,
        hypothesisId: hypothesis.hypothesisId,
        developmentEpochId,
        holdoutEpochId,
        branch: prepared.branch,
        confinementOk: false,
        baseCommit,
      }
      await persistScheduleReport(opts.archiveRoot, hypothesis.hypothesisId, report)
      return report
    }

    const policyAbs = join(prepared.worktreePath, DECISION_POLICY_REL_PATH)
    try {
      loadPolicy(policyAbs)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await writeRejectionReceipt(opts.archiveRoot, {
        schema: 1,
        hypothesisId: hypothesis.hypothesisId,
        rejectedAt: nowIso,
        phase: "static_validated",
        reason: `policy schema: ${detail}`.slice(0, 500),
      })
      const report: HarnessImproveReport = {
        status: "rejected",
        reason: `policy schema: ${detail}`,
        hypothesisId: hypothesis.hypothesisId,
        developmentEpochId,
        holdoutEpochId,
        branch: prepared.branch,
        confinementOk: true,
        baseCommit,
      }
      await persistScheduleReport(opts.archiveRoot, hypothesis.hypothesisId, report)
      return report
    }

    let testsOk = true
    if (opts.runTests !== false) {
      const script = hi.test_command.trim() || "test:all"
      const run = exec("pnpm", ["run", script], { cwd: prepared.worktreePath })
      testsOk = run.status === 0
      if (!testsOk) {
        const detail = (run.stderr || run.stdout || "").slice(0, 500)
        await writeRejectionReceipt(opts.archiveRoot, {
          schema: 1,
          hypothesisId: hypothesis.hypothesisId,
          rejectedAt: nowIso,
          phase: "static_validated",
          reason: `tests failed: ${detail}`.slice(0, 500),
        })
        const report: HarnessImproveReport = {
          status: "rejected",
          reason: `tests failed: ${detail}`,
          hypothesisId: hypothesis.hypothesisId,
          developmentEpochId,
          holdoutEpochId,
          branch: prepared.branch,
          confinementOk: true,
          testsOk: false,
          baseCommit,
        }
        await persistScheduleReport(opts.archiveRoot, hypothesis.hypothesisId, report)
        return report
      }
    }

    await saveHypothesis(opts.archiveRoot, {
      ...loadHypothesis(opts.archiveRoot, hypothesis.hypothesisId),
      status: "static_validated",
    })
    await advanceHarnessJournal(
      opts.archiveRoot,
      hypothesis.hypothesisId,
      "static_validated",
      sha256Json({ confinementOk: true, testsOk } as never),
    )

    const evaluation = await evaluateHypothesis({
      archiveRoot: opts.archiveRoot,
      hypothesisId: hypothesis.hypothesisId,
      developmentEpochId,
      holdoutEpochId,
      repoRoot: opts.repoRoot,
      nowIso,
      runTests: false,
      loadHoldoutSubjects: loadHoldoutSubjectsWithSignalsOrThrow,
    })
    const holdoutOk = evaluation.primaryImproved
      && evaluation.safetyFloorsPassed
      && evaluation.testsPassed
      && !evaluation.rejectReason
    if (!holdoutOk) {
      const report: HarnessImproveReport = {
        status: "rejected",
        reason: evaluation.rejectReason ?? "holdout evaluation failed",
        hypothesisId: hypothesis.hypothesisId,
        developmentEpochId,
        holdoutEpochId,
        branch: prepared.branch,
        confinementOk: evaluation.confinementPassed,
        testsOk: evaluation.testsPassed,
        baseCommit,
        candidateCommit: evaluation.candidateCommit,
      }
      await persistScheduleReport(opts.archiveRoot, hypothesis.hypothesisId, report)
      return report
    }
    await advanceHarnessJournal(
      opts.archiveRoot,
      hypothesis.hypothesisId,
      "holdout_evaluated",
      sha256Json(evaluation as never),
    )

    const evaluationHash = sha256Json(evaluation as never)
    const policyBytes = readFileSync(policyAbs)
    const diffHash = sha256Bytes(policyBytes)
    const implReview = await runHarnessReview({
      archiveRoot: opts.archiveRoot,
      hypothesisId: hypothesis.hypothesisId,
      repoRoot: opts.repoRoot,
      phase: "implementation",
      model: hi.reviewer_model,
      nowIso,
      artifactPaths: [
        join(hypothesisDir(opts.archiveRoot, hypothesis.hypothesisId), "evaluation.json"),
        policyAbs,
      ],
      planHash: planned.planHash,
      evaluationHash,
      diffHash,
      ...(runSession ? { runSession } : {}),
    })
    if (!implReview.ok) {
      await writeRejectionReceipt(opts.archiveRoot, {
        schema: 1,
        hypothesisId: hypothesis.hypothesisId,
        rejectedAt: nowIso,
        phase: "implementation_approved",
        reason: implReview.reason.slice(0, 500),
        evaluationHash,
      })
      const report: HarnessImproveReport = {
        status: "rejected",
        reason: implReview.reason,
        hypothesisId: hypothesis.hypothesisId,
        developmentEpochId,
        holdoutEpochId,
        branch: prepared.branch,
        baseCommit,
        candidateCommit: evaluation.candidateCommit,
      }
      await persistScheduleReport(opts.archiveRoot, hypothesis.hypothesisId, report)
      return report
    }
    const implApproval = validateReviewApproval(implReview.review)
    if (!implApproval.ok) {
      await writeRejectionReceipt(opts.archiveRoot, {
        schema: 1,
        hypothesisId: hypothesis.hypothesisId,
        rejectedAt: nowIso,
        phase: "implementation_approved",
        reason: implApproval.reason,
        evaluationHash,
        reviewHash: implReview.reviewHash,
      })
      const report: HarnessImproveReport = {
        status: "rejected",
        reason: implApproval.reason,
        hypothesisId: hypothesis.hypothesisId,
        developmentEpochId,
        holdoutEpochId,
        branch: prepared.branch,
        baseCommit,
        candidateCommit: evaluation.candidateCommit,
      }
      await persistScheduleReport(opts.archiveRoot, hypothesis.hypothesisId, report)
      return report
    }
    await saveHypothesis(opts.archiveRoot, {
      ...loadHypothesis(opts.archiveRoot, hypothesis.hypothesisId),
      status: "implementation_approved",
    })
    await advanceHarnessJournal(
      opts.archiveRoot,
      hypothesis.hypothesisId,
      "implementation_approved",
      implReview.reviewHash,
    )

    if (opts.dryRun || !hi.integrate_local_main) {
      const report: HarnessImproveReport = {
        status: "evaluated_no_deploy",
        reason: opts.dryRun ? "dry-run" : "integrate_local_main is false",
        hypothesisId: hypothesis.hypothesisId,
        developmentEpochId,
        holdoutEpochId,
        branch: prepared.branch,
        confinementOk: true,
        testsOk,
        baseCommit,
        candidateCommit: evaluation.candidateCommit,
      }
      await persistScheduleReport(opts.archiveRoot, hypothesis.hypothesisId, report)
      return report
    }

    const meta = readWorktreeMeta(opts.archiveRoot, hypothesis.hypothesisId)
    let candidateSha: string
    try {
      candidateSha = commitCandidateBranch(
        meta.worktreePath,
        `harness: ${hypothesis.primaryMetric} (${hypothesis.hypothesisId})`,
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const report: HarnessImproveReport = {
        status: "failed",
        reason: `commit: ${detail}`,
        hypothesisId: hypothesis.hypothesisId,
        developmentEpochId,
        holdoutEpochId,
        branch: meta.branch,
        baseCommit,
      }
      await persistScheduleReport(opts.archiveRoot, hypothesis.hypothesisId, report)
      return report
    }
    await saveHypothesis(opts.archiveRoot, {
      ...loadHypothesis(opts.archiveRoot, hypothesis.hypothesisId),
      status: "committed",
    })
    await advanceHarnessJournal(
      opts.archiveRoot,
      hypothesis.hypothesisId,
      "committed",
      sha256Json({ candidateSha } as never),
    )

    try {
      fastForwardLocalMain({
        repoRoot: opts.repoRoot,
        baseSha: baseCommit,
        branch: meta.branch,
        candidateSha,
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const report: HarnessImproveReport = {
        status: "failed",
        reason: `integrate: ${detail}`,
        hypothesisId: hypothesis.hypothesisId,
        developmentEpochId,
        holdoutEpochId,
        branch: meta.branch,
        baseCommit,
        candidateCommit: candidateSha,
      }
      await persistScheduleReport(opts.archiveRoot, hypothesis.hypothesisId, report)
      return report
    }
    await saveHypothesis(opts.archiveRoot, {
      ...loadHypothesis(opts.archiveRoot, hypothesis.hypothesisId),
      status: "integrated",
    })
    await advanceHarnessJournal(
      opts.archiveRoot,
      hypothesis.hypothesisId,
      "integrated",
      sha256Json({ candidateSha, baseCommit } as never),
    )

    if (hi.deploy_runtime && opts.skipDeploy !== true) {
      const deploy = await deployRuntimeFromRepo({
        repoRoot: opts.repoRoot,
        archiveRoot: opts.archiveRoot,
        sourceCommit: candidateSha,
        hypothesisId: hypothesis.hypothesisId,
        nowIso,
      })
      if (!deploy.ok) {
        const report: HarnessImproveReport = {
          status: "failed",
          reason: `deploy: ${(deploy.stderr || deploy.stdout).slice(0, 500)}`,
          hypothesisId: hypothesis.hypothesisId,
          developmentEpochId,
          holdoutEpochId,
          branch: meta.branch,
          baseCommit,
          candidateCommit: candidateSha,
        }
        await persistScheduleReport(opts.archiveRoot, hypothesis.hypothesisId, report)
        return report
      }
      await saveHypothesis(opts.archiveRoot, {
        ...loadHypothesis(opts.archiveRoot, hypothesis.hypothesisId),
        status: "runtime_deployed",
      })
      await advanceHarnessJournal(
        opts.archiveRoot,
        hypothesis.hypothesisId,
        "runtime_deployed",
        sha256Json({ exitCode: deploy.exitCode, candidateSha } as never),
      )
    } else {
      // Still advance through runtime_deployed so activation_pending stays sequential
      await saveHypothesis(opts.archiveRoot, {
        ...loadHypothesis(opts.archiveRoot, hypothesis.hypothesisId),
        status: "runtime_deployed",
      })
      await advanceHarnessJournal(
        opts.archiveRoot,
        hypothesis.hypothesisId,
        "runtime_deployed",
        sha256Json({ skipped: true, reason: "deploy_runtime false or skipDeploy" } as never),
      )
    }

    const sourceHash = sha256Bytes(readFileSync(join(opts.repoRoot, DECISION_POLICY_REL_PATH)))
    await writePendingAgentDeploymentManifest({
      archiveRoot: opts.archiveRoot,
      hypothesisId: hypothesis.hypothesisId,
      sourceCommit: candidateSha,
      files: [{ relPath: DECISION_POLICY_REL_PATH, sourceHash }],
      nowIso,
    })
    await saveHypothesis(opts.archiveRoot, {
      ...loadHypothesis(opts.archiveRoot, hypothesis.hypothesisId),
      status: "activation_pending",
    })
    await advanceHarnessJournal(
      opts.archiveRoot,
      hypothesis.hypothesisId,
      "activation_pending",
      sha256Json({ sourceCommit: candidateSha, deferred: true } as never),
    )

    const report: HarnessImproveReport = {
      status: "activation_pending",
      hypothesisId: hypothesis.hypothesisId,
      developmentEpochId,
      holdoutEpochId,
      branch: meta.branch,
      confinementOk: true,
      testsOk,
      baseCommit,
      candidateCommit: candidateSha,
    }
    await persistScheduleReport(opts.archiveRoot, hypothesis.hypothesisId, report)
    log.info("harness-improve complete", report as never)
    return report
  } finally {
    lock.release()
  }
}

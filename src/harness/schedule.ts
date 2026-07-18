import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "../lib/config.js"
import { systemClock } from "../lib/clock.js"
import { sha256Json } from "../lib/canonical-json.js"
import { archiveLayout, ensureArchive } from "../lib/archive.js"
import { WorkspaceLock } from "../lib/lock.js"
import { writeAtomicFile } from "../lib/fs-atomic.js"
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
import { advanceHarnessJournal, canaryStatus } from "./lifecycle.js"
import { harnessRoot } from "./canary.js"
import {
  applyDecisionPolicyStub,
  assertRepoRoot,
  defaultExec,
  openHarnessPullRequest,
  persistPrReceipt,
  type ExecFn,
} from "./pr.js"

export type HarnessImproveReport = Readonly<{
  status: "skipped" | "pr_opened" | "evaluated_no_pr" | "failed"
  reason?: string
  hypothesisId?: string
  developmentEpochId?: string
  holdoutEpochId?: string
  branch?: string
  prUrl?: string
  confinementOk?: boolean
  testsOk?: boolean
}>

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

export type RunHarnessImproveOptions = Readonly<{
  archiveRoot: string
  repoRoot: string
  nowIso?: string
  developmentEpochId?: string
  holdoutEpochId?: string
  dryRun?: boolean
  runTests?: boolean
  exec?: ExecFn
}>

/**
 * Scheduled host-only pipeline:
 * sealed epochs → propose → fresh branch → policy stub → build/test → open PR.
 * Never merges. Never starts canary. Human merges the PR.
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

    const hypothesis = await proposeFromSealedEpoch({
      archiveRoot: opts.archiveRoot,
      epochId: developmentEpochId,
      nowIso,
      minEvents: hi.min_events,
      minHoldoutEvents: hi.min_holdout_events,
    })
    await advanceHarnessJournal(
      opts.archiveRoot,
      hypothesis.hypothesisId,
      "proposed",
      sha256Json(hypothesis as never),
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

    await applyDecisionPolicyStub({
      worktreePath: prepared.worktreePath,
      hypothesis,
    })

    const confinement = evaluateWorktreeConfinement({
      worktreePath: prepared.worktreePath,
      allowlist: hypothesis.allowlistPaths,
      repoRoot: opts.repoRoot,
    })
    if (!confinement.ok) {
      const report: HarnessImproveReport = {
        status: "failed",
        reason: `confinement: ${confinement.violations.join(",")}`,
        hypothesisId: hypothesis.hypothesisId,
        developmentEpochId,
        holdoutEpochId,
        branch: prepared.branch,
        confinementOk: false,
      }
      await writeAtomicFile(
        join(hypothesisDir(opts.archiveRoot, hypothesis.hypothesisId), "schedule-report.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      )
      return report
    }

    let testsOk = true
    if (opts.runTests !== false) {
      const script = hi.test_command.trim() || "test:unit"
      const run = exec("pnpm", ["run", script], { cwd: prepared.worktreePath })
      testsOk = run.status === 0
      if (!testsOk) {
        const detail = (run.stderr || run.stdout || "").slice(0, 500)
        return {
          status: "failed",
          reason: `tests failed: ${detail}`,
          hypothesisId: hypothesis.hypothesisId,
          developmentEpochId,
          holdoutEpochId,
          branch: prepared.branch,
          confinementOk: true,
          testsOk: false,
        }
      }
    }

    await saveHypothesis(opts.archiveRoot, {
      ...loadHypothesis(opts.archiveRoot, hypothesis.hypothesisId),
      status: "evaluated",
    })
    await advanceHarnessJournal(
      opts.archiveRoot,
      hypothesis.hypothesisId,
      "evaluated",
      sha256Json({
        confinementOk: true,
        testsOk,
        developmentEpochId,
        holdoutEpochId,
      } as never),
    )

    const title = `harness: ${hypothesis.primaryMetric} (${hypothesis.hypothesisId})`
    const body = [
      "## Summary",
      `- Hypothesis \`${hypothesis.hypothesisId}\` from sealed epoch \`${developmentEpochId}\``,
      `- Primary metric: \`${hypothesis.primaryMetric}\``,
      `- Holdout reference epoch: \`${holdoutEpochId}\``,
      "",
      "## Rationale",
      hypothesis.rationale,
      "",
      "## Test plan",
      "- [ ] Review allowlisted decision-policy diff only",
      "- [ ] Confirm no audit/router/chat/harness edits",
      "- [ ] After merge, canary remains a separate explicit operator step",
      "",
      "Opened by scheduled `harness-improve`. Does **not** self-merge or enable canary.",
    ].join("\n")

    if (opts.dryRun || !hi.auto_open_pr) {
      const report: HarnessImproveReport = {
        status: "evaluated_no_pr",
        reason: opts.dryRun ? "dry-run" : "auto_open_pr is false",
        hypothesisId: hypothesis.hypothesisId,
        developmentEpochId,
        holdoutEpochId,
        branch: prepared.branch,
        confinementOk: true,
        testsOk,
      }
      await writeAtomicFile(
        join(hypothesisDir(opts.archiveRoot, hypothesis.hypothesisId), "schedule-report.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      )
      return report
    }

    const meta = readWorktreeMeta(opts.archiveRoot, hypothesis.hypothesisId)
    const pr = openHarnessPullRequest({
      worktreePath: meta.worktreePath,
      branch: meta.branch,
      baseBranch: hi.base_branch,
      title,
      body,
      push: true,
      createPr: true,
      ...(opts.exec ? { exec: opts.exec } : {}),
    })
    await persistPrReceipt({
      archiveRoot: opts.archiveRoot,
      hypothesisId: hypothesis.hypothesisId,
      result: pr,
      branch: meta.branch,
      nowIso,
    })

    const report: HarnessImproveReport = {
      status: pr.prUrl || pr.pushed ? "pr_opened" : "evaluated_no_pr",
      hypothesisId: hypothesis.hypothesisId,
      developmentEpochId,
      holdoutEpochId,
      branch: meta.branch,
      ...(pr.prUrl ? { prUrl: pr.prUrl } : {}),
      ...(pr.skippedReason ? { reason: pr.skippedReason } : {}),
      confinementOk: true,
      testsOk,
    }
    await writeAtomicFile(
      join(hypothesisDir(opts.archiveRoot, hypothesis.hypothesisId), "schedule-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    )
    log.info("harness-improve complete", report as never)
    return report
  } finally {
    lock.release()
  }
}

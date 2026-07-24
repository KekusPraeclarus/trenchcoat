import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { sha256Json } from "../lib/canonical-json.js"
import {
  HarnessEvaluationSchema,
  HarnessPlanSchema,
  PROTECTED_QUALITY_METRICS,
  type HarnessEvaluation,
  type Scorecard,
} from "../contracts/schemas.js"
import { loadHypothesis, saveHypothesis, hypothesisDir } from "./propose.js"
import { evaluateWorktreeConfinement, readWorktreeMeta } from "./prepare.js"
import { loadSealedEpoch } from "../orchestrator/scorecard.js"
import { archiveLayout, type ArchiveLayout } from "../lib/archive.js"
import { wilsonLowerBound } from "../orchestrator/audit-math.js"
import { loadPolicy } from "./policy.js"
import { replayHoldoutThroughPolicy, type ReplaySubject } from "./replay.js"
import { isHoldoutConsumed, recordHoldoutConsumption } from "./holdout-registry.js"
import { loadHoldoutSubjectsWithSignalsOrThrow } from "./signals.js"
import { protectedMetricsUnchangedOrImproved } from "./quality.js"
import { validateManifestoAgainstEvaluation } from "./manifesto-validate.js"

const DEFAULT_POLICY_REL_PATH = "agent/skills/decision-policy/policy.json"

type SealedEpoch = ReturnType<typeof loadSealedEpoch>

function defaultGitRevParse(worktreePath: string): string {
  const out = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: worktreePath,
    encoding: "utf8",
  })
  const sha = (out.stdout ?? "").trim()
  if (out.status !== 0 || sha.length < 7) {
    throw new Error(`git rev-parse HEAD failed in ${worktreePath}`)
  }
  return sha
}

function metricValue(scorecard: Scorecard, key: string): number {
  switch (key) {
    case "hitRate":
      return scorecard.hitRate.denominator === 0
        ? 0
        : scorecard.hitRate.numerator / scorecard.hitRate.denominator
    case "ignoreMissRate":
      return scorecard.ignoreMissRate.denominator === 0
        ? 0
        : scorecard.ignoreMissRate.numerator / scorecard.ignoreMissRate.denominator
    case "calibrationBrier":
      return scorecard.calibrationBrier ?? 1
    case "paperPnlCostAdjusted":
      return scorecard.paperPnlCostAdjusted
    case "rugExposure":
      return scorecard.rugExposure.denominator === 0
        ? 0
        : scorecard.rugExposure.numerator / scorecard.rugExposure.denominator
    case "outcomeCoverage":
      return scorecard.outcomeCoverage.denominator === 0
        ? 0
        : scorecard.outcomeCoverage.numerator / scorecard.outcomeCoverage.denominator
    default:
      return Number.NaN
  }
}

function lowerIsBetter(metric: string): boolean {
  return metric === "ignoreMissRate"
    || metric === "calibrationBrier"
    || metric === "rugExposure"
}

export function checkSafetyFloors(
  scorecard: Scorecard,
  floors: Readonly<Record<string, number>>,
): { ok: boolean, breaches: string[] } {
  const breaches: string[] = []
  for (const [key, floor] of Object.entries(floors)) {
    if (key.endsWith("Max")) {
      const metric = key.replace(/Max$/u, "")
      const value = metricValue(scorecard, metric)
      if (Number.isFinite(value) && value > floor) breaches.push(`${key}:${value}`)
    } else if (key.endsWith("Min")) {
      const metric = key.replace(/Min$/u, "")
      const value = metricValue(scorecard, metric)
      if (Number.isFinite(value) && value < floor) breaches.push(`${key}:${value}`)
    }
  }
  return { ok: breaches.length === 0, breaches }
}

export function primaryImproved(
  metric: string,
  baseline: number,
  candidate: number,
  baselineN: number,
  candidateHits: number,
  confidenceLevel = 0.95,
): boolean {
  if (!Number.isFinite(baseline) || !Number.isFinite(candidate)) return false
  if (lowerIsBetter(metric)) {
    if (!(candidate < baseline)) return false
  } else if (!(candidate > baseline)) {
    return false
  }
  // For rate-like metrics require Wilson LB of candidate improvement signal
  if (metric === "hitRate" && baselineN > 0) {
    const z = confidenceLevel >= 0.99 ? 2.576 : 1.96
    return wilsonLowerBound(candidateHits, baselineN, z) > baseline
  }
  return true
}

function protectedMetricEntries(
  baseline: Scorecard,
  candidate: Scorecard,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const key of PROTECTED_QUALITY_METRICS) {
    const base = metricValue(baseline, key)
    const cand = metricValue(candidate, key)
    if (Number.isFinite(base)) out[`protectedBaseline_${key}`] = base
    if (Number.isFinite(cand)) out[`protectedCandidate_${key}`] = cand
  }
  return out
}

export type EvaluateOptions = Readonly<{
  archiveRoot: string
  hypothesisId: string
  developmentEpochId: string
  holdoutEpochId: string
  repoRoot: string
  nowIso: string
  runTests?: boolean
  consumedHoldouts?: ReadonlySet<string>
  // candidate policy file inside the worktree, relative to its root
  policyRelPath?: string
  // injectable so tests need no real git; defaults to git rev-parse HEAD
  gitRevParse?: (worktreePath: string) => string
  // injectable holdout evidence; defaults to archived decision-time signals
  loadHoldoutSubjects?: (
    layout: ArchiveLayout,
    holdout: SealedEpoch,
  ) => readonly ReplaySubject[]
}>

export async function evaluateHypothesis(
  opts: EvaluateOptions,
): Promise<HarnessEvaluation> {
  const hypothesis = loadHypothesis(opts.archiveRoot, opts.hypothesisId)
  if (
    opts.consumedHoldouts?.has(opts.holdoutEpochId)
    || isHoldoutConsumed(opts.archiveRoot, opts.holdoutEpochId)
  ) {
    throw new Error(`Holdout epoch ${opts.holdoutEpochId} already consumed`)
  }
  if (opts.developmentEpochId === opts.holdoutEpochId) {
    throw new Error("Development and holdout epochs must differ")
  }

  const meta = readWorktreeMeta(opts.archiveRoot, opts.hypothesisId)
  const confinement = evaluateWorktreeConfinement({
    worktreePath: meta.worktreePath,
    allowlist: hypothesis.allowlistPaths,
    repoRoot: opts.repoRoot,
  })

  const gitRevParse = opts.gitRevParse ?? defaultGitRevParse
  const candidateCommit = gitRevParse(meta.worktreePath)

  const layout = archiveLayout(opts.archiveRoot)
  const development = loadSealedEpoch(layout, opts.developmentEpochId)
  const baselineMetric = metricValue(development.scorecard, hypothesis.primaryMetric)
  const baselineCommit = development.manifest.codeCommit

  // Fail closed if the candidate policy is absent, and never burn the holdout
  const policyRelPath = opts.policyRelPath ?? DEFAULT_POLICY_REL_PATH
  const policyPath = join(meta.worktreePath, policyRelPath)
  if (!existsSync(policyPath)) {
    const evaluation = HarnessEvaluationSchema.parse({
      schema: 1,
      hypothesisId: opts.hypothesisId,
      evaluatedAt: opts.nowIso,
      baselineCommit,
      candidateCommit,
      developmentEpochId: opts.developmentEpochId,
      holdoutEpochId: opts.holdoutEpochId,
      testsPassed: false,
      confinementPassed: confinement.ok,
      primaryImproved: false,
      safetyFloorsPassed: false,
      holdoutConsumed: false,
      metrics: { baseline: baselineMetric, candidate: 0, holdoutN: 0 },
      rejectReason: `policy file missing: ${policyRelPath}`,
    })
    await persistEvaluation(opts.archiveRoot, evaluation, "rejected")
    return evaluation
  }
  const policy = loadPolicy(policyPath)

  let testsPassed = true
  if (opts.runTests !== false) {
    const test = spawnSync("pnpm", ["test:unit"], {
      cwd: meta.worktreePath,
      encoding: "utf8",
      timeout: 120_000,
    })
    testsPassed = test.status === 0
  }

  const holdout = loadSealedEpoch(layout, opts.holdoutEpochId)
  const loadSubjects = opts.loadHoldoutSubjects ?? loadHoldoutSubjectsWithSignalsOrThrow
  const subjects = loadSubjects(layout, holdout)

  // Candidate metric comes from replaying the sealed holdout through the
  // worktree policy, never from the holdout's own sealed scorecard
  const candidateScorecard = replayHoldoutThroughPolicy({
    epochId: opts.holdoutEpochId,
    sealedAt: holdout.status.sealedAt ?? opts.nowIso,
    manifestHash: holdout.manifest.manifestHash,
    policy,
    subjects,
    layout,
  })
  const candidateMetric = metricValue(candidateScorecard, hypothesis.primaryMetric)
  const safety = checkSafetyFloors(candidateScorecard, hypothesis.safetyFloors)
  const holdoutN = candidateScorecard.outcomeCoverage.denominator
  const protectedCheck = protectedMetricsUnchangedOrImproved(
    development.scorecard,
    candidateScorecard,
    hypothesis.primaryMetric,
  )
  const protectedMetrics = protectedMetricEntries(
    development.scorecard,
    candidateScorecard,
  )

  if (holdoutN < hypothesis.sampleRequirements.minHoldoutEvents) {
    await recordHoldoutConsumption({
      archiveRoot: opts.archiveRoot,
      consumption: {
        schema: 1,
        epochId: opts.holdoutEpochId,
        hypothesisId: opts.hypothesisId,
        consumedAt: opts.nowIso,
        candidateCommit,
      },
    })
    const evaluation = HarnessEvaluationSchema.parse({
      schema: 1,
      hypothesisId: opts.hypothesisId,
      evaluatedAt: opts.nowIso,
      baselineCommit,
      candidateCommit,
      developmentEpochId: opts.developmentEpochId,
      holdoutEpochId: opts.holdoutEpochId,
      testsPassed,
      confinementPassed: confinement.ok,
      primaryImproved: false,
      safetyFloorsPassed: false,
      holdoutConsumed: true,
      metrics: {
        baseline: baselineMetric,
        candidate: candidateMetric,
        holdoutN,
        ...protectedMetrics,
      },
      rejectReason: "insufficient holdout sample",
    })
    await persistEvaluation(opts.archiveRoot, evaluation, "rejected")
    return evaluation
  }

  const improved = primaryImproved(
    hypothesis.primaryMetric,
    baselineMetric,
    candidateMetric,
    holdoutN,
    candidateScorecard.hitRate.numerator,
  )

  // holdoutConsumed is only true once the registry write has succeeded
  await recordHoldoutConsumption({
    archiveRoot: opts.archiveRoot,
    consumption: {
      schema: 1,
      epochId: opts.holdoutEpochId,
      hypothesisId: opts.hypothesisId,
      consumedAt: opts.nowIso,
      candidateCommit,
    },
  })

  const ok = testsPassed
    && confinement.ok
    && improved
    && safety.ok
    && protectedCheck.ok
  let evaluation = HarnessEvaluationSchema.parse({
    schema: 1,
    hypothesisId: opts.hypothesisId,
    evaluatedAt: opts.nowIso,
    baselineCommit,
    candidateCommit,
    developmentEpochId: opts.developmentEpochId,
    holdoutEpochId: opts.holdoutEpochId,
    testsPassed,
    confinementPassed: confinement.ok,
    primaryImproved: improved,
    safetyFloorsPassed: safety.ok,
    holdoutConsumed: true,
    metrics: {
      baseline: baselineMetric,
      candidate: candidateMetric,
      holdoutN,
      ...protectedMetrics,
    },
    ...(ok ? {} : {
      rejectReason: [
        !testsPassed ? "tests" : "",
        !confinement.ok ? `confinement:${confinement.violations.join(",")}` : "",
        !improved ? "primary-not-improved" : "",
        !safety.ok ? `safety:${safety.breaches.join(",")}` : "",
        !protectedCheck.ok
          ? `protected:${protectedCheck.regressions.join(",")}`
          : "",
      ].filter(Boolean).join("; "),
    }),
  })

  const manifesto = await attachManifestoValidation(
    opts.archiveRoot,
    evaluation,
    opts.nowIso,
  )
  evaluation = manifesto.evaluation
  const finalOk = ok && manifesto.ok
  if (ok && !manifesto.ok) {
    evaluation = HarnessEvaluationSchema.parse({
      ...evaluation,
      rejectReason: [
        evaluation.rejectReason,
        "manifesto:unpredicted-protected-regression",
      ].filter(Boolean).join("; ").slice(0, 280),
    })
  }

  await persistEvaluation(
    opts.archiveRoot,
    evaluation,
    finalOk ? "holdout_evaluated" : "rejected",
  )
  return evaluation
}

async function attachManifestoValidation(
  archiveRoot: string,
  evaluation: HarnessEvaluation,
  nowIso: string,
): Promise<{ evaluation: HarnessEvaluation, ok: boolean }> {
  const dir = hypothesisDir(archiveRoot, evaluation.hypothesisId)
  const planPath = join(dir, "plan.json")
  if (!existsSync(planPath)) return { evaluation, ok: true }
  let plan
  try {
    plan = HarnessPlanSchema.parse(JSON.parse(readFileSync(planPath, "utf8")))
  } catch {
    return { evaluation, ok: true }
  }
  const manifesto = validateManifestoAgainstEvaluation(plan, evaluation.metrics, {
    hypothesisId: evaluation.hypothesisId,
    validatedAt: nowIso,
  })
  await writeAtomicFile(
    join(dir, "manifesto-validation.json"),
    `${JSON.stringify(manifesto, null, 2)}\n`,
  )
  const manifestoValidationHash = sha256Json(manifesto as never)
  return {
    evaluation: HarnessEvaluationSchema.parse({
      ...evaluation,
      manifestoValidationHash,
    }),
    ok: manifesto.ok,
  }
}

async function persistEvaluation(
  archiveRoot: string,
  evaluation: HarnessEvaluation,
  status: "holdout_evaluated" | "rejected",
): Promise<void> {
  const dir = hypothesisDir(archiveRoot, evaluation.hypothesisId)
  await writeAtomicFile(
    join(dir, "evaluation.json"),
    `${JSON.stringify(evaluation, null, 2)}\n`,
  )
  const hypothesis = loadHypothesis(archiveRoot, evaluation.hypothesisId)
  await saveHypothesis(archiveRoot, { ...hypothesis, status })
}

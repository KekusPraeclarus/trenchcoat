import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { archiveLayout, type ArchiveLayout } from "../lib/archive.js"
import { loadSealedEpoch } from "../orchestrator/scorecard.js"
import {
  DecisionPolicyDocumentSchema,
  HarnessImproverConfigSchema,
  MetaCandidateSchema,
  MetaTrialPairSchema,
  MetaUtilitySummarySchema,
  type DecisionPolicyDocument,
  type HarnessImproverConfig,
  type MetaCandidate,
  type MetaTrialPair,
  type MetaUtilitySummary,
  type Scorecard,
} from "../contracts/schemas.js"
import { harnessRoot } from "./canary.js"
import {
  improverConfigHash,
  loadImproverConfig,
} from "./improver-config.js"
import { mineWeaknessFromSealedEpoch } from "./weakness-mining.js"
import { loadPolicy } from "./policy.js"
import { DECISION_POLICY_REL_PATH } from "./paths.js"
import { replayHoldoutThroughPolicy, type ReplaySubject } from "./replay.js"
import {
  isHoldoutConsumed,
  recordHoldoutConsumption,
} from "./holdout-registry.js"
import { loadHoldoutSubjectsWithSignalsOrThrow } from "./signals.js"
import { protectedMetricsUnchangedOrImproved } from "./quality.js"
import { computeMetaUtility } from "./meta-utility.js"

type SealedEpoch = ReturnType<typeof loadSealedEpoch>

export function metaRoot(archiveRoot: string): string {
  return join(harnessRoot(archiveRoot), "meta")
}

export function metaCandidateDir(archiveRoot: string, candidateId: string): string {
  return join(metaRoot(archiveRoot), candidateId)
}

export function listMetaCandidateIds(archiveRoot: string): string[] {
  const root = metaRoot(archiveRoot)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
}

export function loadMetaCandidate(
  archiveRoot: string,
  candidateId: string,
): MetaCandidate {
  const path = join(metaCandidateDir(archiveRoot, candidateId), "candidate.json")
  return MetaCandidateSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

export async function saveMetaCandidate(
  archiveRoot: string,
  candidate: MetaCandidate,
): Promise<void> {
  const dir = metaCandidateDir(archiveRoot, candidate.candidateId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  await writeAtomicFile(
    join(dir, "candidate.json"),
    `${JSON.stringify(MetaCandidateSchema.parse(candidate), null, 2)}\n`,
  )
}

export function loadCandidateImproverConfig(
  archiveRoot: string,
  candidateId: string,
): HarnessImproverConfig {
  const path = join(metaCandidateDir(archiveRoot, candidateId), "candidate-config.json")
  if (!existsSync(path)) {
    throw new Error(`candidate-config.json missing for ${candidateId}`)
  }
  return HarnessImproverConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

export async function saveCandidateImproverConfig(
  archiveRoot: string,
  candidateId: string,
  config: HarnessImproverConfig,
): Promise<void> {
  const dir = metaCandidateDir(archiveRoot, candidateId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const parsed = HarnessImproverConfigSchema.parse(config)
  await writeAtomicFile(
    join(dir, "candidate-config.json"),
    `${JSON.stringify(parsed, null, 2)}\n`,
  )
}

function trialsDir(archiveRoot: string, candidateId: string): string {
  return join(metaCandidateDir(archiveRoot, candidateId), "trials")
}

export function listTrials(archiveRoot: string, candidateId: string): MetaTrialPair[] {
  const dir = trialsDir(archiveRoot, candidateId)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) =>
      MetaTrialPairSchema.parse(
        JSON.parse(readFileSync(join(dir, name), "utf8")),
      )
    )
}

export function loadTrial(
  archiveRoot: string,
  candidateId: string,
  trialId: string,
): MetaTrialPair | undefined {
  const path = join(trialsDir(archiveRoot, candidateId), `${trialId}.json`)
  if (!existsSync(path)) return undefined
  return MetaTrialPairSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

export async function saveTrial(
  archiveRoot: string,
  pair: MetaTrialPair,
): Promise<void> {
  const dir = trialsDir(archiveRoot, pair.candidateId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  await writeAtomicFile(
    join(dir, `${pair.trialId}.json`),
    `${JSON.stringify(MetaTrialPairSchema.parse(pair), null, 2)}\n`,
  )
}

export function loadUtility(
  archiveRoot: string,
  candidateId: string,
): MetaUtilitySummary | undefined {
  const path = join(metaCandidateDir(archiveRoot, candidateId), "utility.json")
  if (!existsSync(path)) return undefined
  return MetaUtilitySummarySchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

export async function saveUtility(
  archiveRoot: string,
  summary: MetaUtilitySummary,
): Promise<void> {
  const dir = metaCandidateDir(archiveRoot, summary.candidateId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  await writeAtomicFile(
    join(dir, "utility.json"),
    `${JSON.stringify(MetaUtilitySummarySchema.parse(summary), null, 2)}\n`,
  )
}

export async function recomputeAndSaveUtility(opts: Readonly<{
  archiveRoot: string
  candidateId: string
  nowIso: string
  safetyIntegrityOk?: boolean
}>): Promise<MetaUtilitySummary> {
  const summary = computeMetaUtility({
    candidateId: opts.candidateId,
    nowIso: opts.nowIso,
    pairs: listTrials(opts.archiveRoot, opts.candidateId),
    ...(opts.safetyIntegrityOk !== undefined
      ? { safetyIntegrityOk: opts.safetyIntegrityOk }
      : {}),
  })
  await saveUtility(opts.archiveRoot, summary)
  return summary
}

export function createMetaTrialPair(opts: Readonly<{
  trialId: string
  candidateId: string
  developmentEpochId: string
  holdoutEpochId: string
  nowIso: string
  baselineHypothesisId: string
  candidateHypothesisId: string
}>): MetaTrialPair {
  return MetaTrialPairSchema.parse({
    schema: 1,
    trialId: opts.trialId,
    candidateId: opts.candidateId,
    developmentEpochId: opts.developmentEpochId,
    holdoutEpochId: opts.holdoutEpochId,
    createdAt: opts.nowIso,
    baselineHypothesisId: opts.baselineHypothesisId,
    candidateHypothesisId: opts.candidateHypothesisId,
  })
}

export function metaTrialId(opts: Readonly<{
  candidateId: string
  developmentEpochId: string
  holdoutEpochId: string
}>): string {
  const digest = createHash("sha256")
    .update(`${opts.candidateId}:${opts.developmentEpochId}:${opts.holdoutEpochId}`)
    .digest("hex")
    .slice(0, 24)
  return `mt-${digest}`
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

/** Signed improvement: positive means better than development baseline */
export function signedPrimaryDelta(
  metric: string,
  developmentValue: number,
  replayValue: number,
): number {
  if (!Number.isFinite(developmentValue) || !Number.isFinite(replayValue)) {
    return Number.NaN
  }
  if (lowerIsBetter(metric)) return developmentValue - replayValue
  return replayValue - developmentValue
}

function fallbackPrimaryMetric(sealed: SealedEpoch): string {
  const sc = sealed.scorecard
  const hitDenom = sc.hitRate.denominator
  const hitRate = hitDenom === 0 ? 0 : sc.hitRate.numerator / hitDenom
  const missDenom = sc.ignoreMissRate.denominator
  const missRate = missDenom === 0 ? 0 : sc.ignoreMissRate.numerator / missDenom
  const cal = sc.calibrationBrier ?? 1
  if (hitRate < 0.5 && hitDenom >= 5) return "hitRate"
  if (missRate > 0.4 && missDenom >= 5) return "ignoreMissRate"
  if (cal > 0.25) return "calibrationBrier"
  return "paperPnlCostAdjusted"
}

function pickPrimaryMetric(
  layout: ArchiveLayout,
  improverConfig: HarnessImproverConfig,
  sealed: SealedEpoch,
): string {
  const report = mineWeaknessFromSealedEpoch(layout, sealed, improverConfig)
  const priority = improverConfig.propose.weakMetricPriority
  const ranked = [...report.patterns].sort((a, b) => {
    const aPri = priority[a.primaryMetricHint ?? ""] ?? 0
    const bPri = priority[b.primaryMetricHint ?? ""] ?? 0
    if (bPri !== aPri) return bPri - aPri
    if (b.score !== a.score) return b.score - a.score
    return a.patternId.localeCompare(b.patternId)
  })
  return ranked[0]?.primaryMetricHint ?? fallbackPrimaryMetric(sealed)
}

/**
 * Deterministic, schema-valid policy nudge from the selected primary metric.
 * Never writes the active policy path — returns a candidate document only.
 */
export function nudgePolicyForWeakness(
  policy: DecisionPolicyDocument,
  primaryMetric: string,
): DecisionPolicyDocument {
  const thresholds = { ...policy.thresholds }
  const weights = { ...policy.weights }
  const track = thresholds["track"] ?? 0.5

  switch (primaryMetric) {
    case "hitRate":
      thresholds["track"] = Math.min(0.95, track + 0.05)
      break
    case "ignoreMissRate":
      thresholds["track"] = Math.max(-0.2, track - 0.05)
      break
    case "calibrationBrier": {
      const key = Object.keys(weights).sort()[0] ?? "confidence"
      weights[key] = Number(((weights[key] ?? 0.1) * 0.9).toFixed(6))
      break
    }
    case "paperPnlCostAdjusted": {
      const key = Object.keys(weights).sort()[0] ?? "confidence"
      weights[key] = Number(((weights[key] ?? 0.1) + 0.05).toFixed(6))
      break
    }
    default:
      thresholds["track"] = Math.min(0.95, track + 0.02)
  }

  const version = `meta-nudge-${primaryMetric}`.replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 128)
  return DecisionPolicyDocumentSchema.parse({
    ...policy,
    policyVersion: version.length > 0 ? version : "meta-nudge",
    kind: "candidate",
    weights,
    thresholds,
  })
}

function countProtectedRegressions(
  development: Scorecard,
  replay: Scorecard,
  primaryMetric: string,
): number {
  return protectedMetricsUnchangedOrImproved(
    development,
    replay,
    primaryMetric,
  ).regressions.length
}

function gradeSide(opts: Readonly<{
  layout: ArchiveLayout
  improverConfig: HarnessImproverConfig
  development: SealedEpoch
  holdout: SealedEpoch
  policy: DecisionPolicyDocument
  subjects: readonly ReplaySubject[]
  holdoutEpochId: string
  nowIso: string
}>): Readonly<{
  primaryMetric: string
  delta: number
  protectedRegressions: number
  invalid: boolean
}> {
  try {
    const primaryMetric = pickPrimaryMetric(
      opts.layout,
      opts.improverConfig,
      opts.development,
    )
    const nudged = nudgePolicyForWeakness(opts.policy, primaryMetric)
    const replay = replayHoldoutThroughPolicy({
      epochId: opts.holdoutEpochId,
      sealedAt: opts.holdout.status.sealedAt ?? opts.nowIso,
      manifestHash: opts.holdout.manifest.manifestHash,
      policy: nudged,
      subjects: opts.subjects,
      layout: opts.layout,
    })
    const developmentValue = metricValue(opts.development.scorecard, primaryMetric)
    const replayValue = metricValue(replay, primaryMetric)
    const delta = signedPrimaryDelta(primaryMetric, developmentValue, replayValue)
    if (!Number.isFinite(delta)) {
      return { primaryMetric, delta: 0, protectedRegressions: 0, invalid: true }
    }
    return {
      primaryMetric,
      delta,
      protectedRegressions: countProtectedRegressions(
        opts.development.scorecard,
        replay,
        primaryMetric,
      ),
      invalid: false,
    }
  } catch {
    return {
      primaryMetric: "paperPnlCostAdjusted",
      delta: 0,
      protectedRegressions: 0,
      invalid: true,
    }
  }
}

function pickWinner(opts: Readonly<{
  baselineDelta: number
  candidateDelta: number
  baselineInvalid: boolean
  candidateInvalid: boolean
}>): "baseline" | "candidate" | "tie" {
  if (opts.baselineInvalid && opts.candidateInvalid) return "tie"
  if (opts.baselineInvalid) return "candidate"
  if (opts.candidateInvalid) return "baseline"
  if (opts.candidateDelta > opts.baselineDelta) return "candidate"
  if (opts.baselineDelta > opts.candidateDelta) return "baseline"
  return "tie"
}

export type RunMetaTrialPairOptions = Readonly<{
  archiveRoot: string
  repoRoot: string
  candidateId: string
  developmentEpochId: string
  holdoutEpochId: string
  nowIso: string
  trialId?: string
  /** Injectable for tests — defaults to archived decision-time signals */
  loadHoldoutSubjects?: (
    layout: ArchiveLayout,
    holdout: SealedEpoch,
  ) => readonly ReplaySubject[]
}>

/**
 * Paired offline baseline vs candidate improver-config trial (ADR 039).
 * Shadow only: never writes active policy or promotes config.
 */
export async function runMetaTrialPair(
  opts: RunMetaTrialPairOptions,
): Promise<MetaTrialPair> {
  if (opts.developmentEpochId === opts.holdoutEpochId) {
    throw new Error("Development and holdout epochs must differ")
  }

  const trialId = opts.trialId ?? metaTrialId({
    candidateId: opts.candidateId,
    developmentEpochId: opts.developmentEpochId,
    holdoutEpochId: opts.holdoutEpochId,
  })
  const existing = loadTrial(opts.archiveRoot, opts.candidateId, trialId)
  if (existing?.holdoutConsumed) return existing

  if (isHoldoutConsumed(opts.archiveRoot, opts.holdoutEpochId)) {
    throw new Error(`Holdout epoch ${opts.holdoutEpochId} already consumed`)
  }

  const candidate = loadMetaCandidate(opts.archiveRoot, opts.candidateId)
  const baselineConfig = loadImproverConfig(opts.repoRoot)
  const candidateConfig = loadCandidateImproverConfig(
    opts.archiveRoot,
    opts.candidateId,
  )
  if (improverConfigHash(candidateConfig) !== candidate.candidateConfigHash) {
    throw new Error("candidate-config.json hash mismatch vs candidate.json")
  }

  const layout = archiveLayout(opts.archiveRoot)
  const development = loadSealedEpoch(layout, opts.developmentEpochId)
  const holdout = loadSealedEpoch(layout, opts.holdoutEpochId)
  const loadSubjects = opts.loadHoldoutSubjects
    ?? loadHoldoutSubjectsWithSignalsOrThrow
  const subjects = loadSubjects(layout, holdout)

  const policyPath = join(opts.repoRoot, DECISION_POLICY_REL_PATH)
  if (!existsSync(policyPath)) {
    throw new Error(`baseline policy missing: ${DECISION_POLICY_REL_PATH}`)
  }
  const baselinePolicy = loadPolicy(policyPath)

  const baselineHypId = `meta-base-${trialId}`.slice(0, 128)
  const candidateHypId = `meta-cand-${trialId}`.slice(0, 128)

  const baselineGrade = gradeSide({
    layout,
    improverConfig: baselineConfig,
    development,
    holdout,
    policy: baselinePolicy,
    subjects,
    holdoutEpochId: opts.holdoutEpochId,
    nowIso: opts.nowIso,
  })
  const candidateGrade = gradeSide({
    layout,
    improverConfig: candidateConfig,
    development,
    holdout,
    policy: baselinePolicy,
    subjects,
    holdoutEpochId: opts.holdoutEpochId,
    nowIso: opts.nowIso,
  })

  const winner = pickWinner({
    baselineDelta: baselineGrade.delta,
    candidateDelta: candidateGrade.delta,
    baselineInvalid: baselineGrade.invalid,
    candidateInvalid: candidateGrade.invalid,
  })

  const commitProxy = improverConfigHash(candidateConfig)
    .replace(/^sha256:/u, "")
    .slice(0, 40)
  const metaHypothesisId = `meta-${opts.candidateId}-${trialId}`.slice(0, 128)

  await recordHoldoutConsumption({
    archiveRoot: opts.archiveRoot,
    consumption: {
      schema: 1,
      epochId: opts.holdoutEpochId,
      hypothesisId: metaHypothesisId,
      consumedAt: opts.nowIso,
      candidateCommit: commitProxy.length >= 7 ? commitProxy : `${commitProxy}0000000`.slice(0, 7),
    },
  })

  const pair = MetaTrialPairSchema.parse({
    schema: 1,
    trialId,
    candidateId: opts.candidateId,
    developmentEpochId: opts.developmentEpochId,
    holdoutEpochId: opts.holdoutEpochId,
    createdAt: opts.nowIso,
    baselineHypothesisId: baselineHypId,
    candidateHypothesisId: candidateHypId,
    baselinePrimaryDelta: baselineGrade.delta,
    candidatePrimaryDelta: candidateGrade.delta,
    winner,
    baselineProtectedRegressions: baselineGrade.protectedRegressions,
    candidateProtectedRegressions: candidateGrade.protectedRegressions,
    baselineInvalid: baselineGrade.invalid,
    candidateInvalid: candidateGrade.invalid,
    holdoutConsumed: true,
  })
  await saveTrial(opts.archiveRoot, pair)
  return pair
}

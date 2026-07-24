import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { sha256Json } from "../lib/canonical-json.js"
import { archiveLayout, ensureArchive } from "../lib/archive.js"
import { loadSealedEpoch } from "../orchestrator/scorecard.js"
import {
  HarnessHypothesisSchema,
  type HarnessHypothesis,
  type HarnessWeaknessPattern,
  type Scorecard,
} from "../contracts/schemas.js"
import { HARNESS_PROPOSE_PROMPT } from "../prompts/host.js"
import { loadImproverConfig, improverConfigHash } from "./improver-config.js"
import { mineWeaknessFromSealedEpoch } from "./weakness-mining.js"
import { buildKeepSummary } from "./keep-summary.js"
import {
  buildPriorAttemptsSummary,
  ensurePriorAttemptsIndex,
  isExactDuplicate,
  isNearDuplicateSamePatternLever,
} from "./prior-attempts.js"

export function hypothesisDir(archiveRoot: string, hypothesisId: string): string {
  return join(archiveRoot, "..", "harness-improvements", hypothesisId)
}

/** Non-hypothesis dirs under harness-improvements (meta lane, deploy scratch) */
const HARNESS_RESERVED_DIRS = new Set(["meta", "_deploy"])

export function listHypothesisIds(archiveRoot: string): string[] {
  const root = join(archiveRoot, "..", "harness-improvements")
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !HARNESS_RESERVED_DIRS.has(d.name))
    .map((d) => d.name)
    .sort()
}

export function loadHypothesis(
  archiveRoot: string,
  hypothesisId: string,
): HarnessHypothesis {
  const path = join(hypothesisDir(archiveRoot, hypothesisId), "hypothesis.json")
  return HarnessHypothesisSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

export async function saveHypothesis(
  archiveRoot: string,
  hypothesis: HarnessHypothesis,
): Promise<void> {
  const dir = hypothesisDir(archiveRoot, hypothesis.hypothesisId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  await writeAtomicFile(
    join(dir, "hypothesis.json"),
    `${JSON.stringify(HarnessHypothesisSchema.parse(hypothesis), null, 2)}\n`,
  )
}

function pickWeakMetric(scorecard: Scorecard): Readonly<{
  primaryMetric: string
  rationale: string
  safetyFloors: Record<string, number>
}> {
  const hitDenom = scorecard.hitRate.denominator
  const hitRate = hitDenom === 0 ? 0 : scorecard.hitRate.numerator / hitDenom
  const missDenom = scorecard.ignoreMissRate.denominator
  const missRate = missDenom === 0 ? 0 : scorecard.ignoreMissRate.numerator / missDenom
  const cal = scorecard.calibrationBrier ?? 1

  if (hitRate < 0.5 && hitDenom >= 5) {
    return {
      primaryMetric: "hitRate",
      rationale: `Hit rate ${hitRate.toFixed(3)} below 0.5 on ${hitDenom} tracks — tighten track bar or source weighting.`,
      safetyFloors: {
        rugExposureMax: 0.25,
        outcomeCoverageMin: 0.7,
        calibrationBrierMax: 0.3,
      },
    }
  }
  if (missRate > 0.4 && missDenom >= 5) {
    return {
      primaryMetric: "ignoreMissRate",
      rationale: `Ignore miss rate ${missRate.toFixed(3)} — research bar may be too high.`,
      safetyFloors: {
        rugExposureMax: 0.25,
        hitRateMin: 0.4,
        outcomeCoverageMin: 0.7,
      },
    }
  }
  if (cal > 0.25) {
    return {
      primaryMetric: "calibrationBrier",
      rationale: `Calibration Brier ${cal.toFixed(3)} is poor — adjust confidence rubric in decision policy.`,
      safetyFloors: {
        hitRateMin: 0.4,
        rugExposureMax: 0.25,
      },
    }
  }
  return {
    primaryMetric: "paperPnlCostAdjusted",
    rationale: "No acute failure mode; propose a bounded decision-policy refinement toward cost-adjusted paper P&L.",
    safetyFloors: {
      rugExposureMax: 0.25,
      outcomeCoverageMin: 0.7,
      calibrationBrierMax: 0.3,
    },
  }
}

function safetyFloorsForMetric(primaryMetric: string): Record<string, number> {
  switch (primaryMetric) {
    case "ignoreMissRate":
      return {
        rugExposureMax: 0.25,
        hitRateMin: 0.4,
        outcomeCoverageMin: 0.7,
      }
    case "calibrationBrier":
      return {
        hitRateMin: 0.4,
        rugExposureMax: 0.25,
      }
    default:
      return {
        rugExposureMax: 0.25,
        outcomeCoverageMin: 0.7,
        calibrationBrierMax: 0.3,
      }
  }
}

function selectFromPatterns(
  patterns: readonly HarnessWeaknessPattern[],
  priority: Readonly<Record<string, number>>,
  maxRationaleChars: number,
): Readonly<{
  primaryMetric: string
  rationale: string
  safetyFloors: Record<string, number>
  pattern: HarnessWeaknessPattern
}> | undefined {
  if (patterns.length === 0) return undefined
  const ranked = [...patterns].sort((a, b) => {
    const aPri = priority[a.primaryMetricHint ?? ""] ?? 0
    const bPri = priority[b.primaryMetricHint ?? ""] ?? 0
    if (bPri !== aPri) return bPri - aPri
    if (b.score !== a.score) return b.score - a.score
    return a.patternId.localeCompare(b.patternId)
  })
  const pattern = ranked[0]
  if (!pattern) return undefined
  const primaryMetric = pattern.primaryMetricHint ?? "paperPnlCostAdjusted"
  const rationale = [
    `Weakness pattern ${pattern.patternId}: ${pattern.label}`,
    `support=${pattern.support} lift=${pattern.lift.toFixed(2)}`,
  ].join(" — ").slice(0, maxRationaleChars)
  return {
    primaryMetric,
    rationale,
    safetyFloors: safetyFloorsForMetric(primaryMetric),
    pattern,
  }
}

export type ProposeOptions = Readonly<{
  archiveRoot: string
  epochId: string
  nowIso: string
  minEvents?: number
  minHoldoutEvents?: number
  repoRoot?: string
  hitThreshold?: number
}>

/** Host-deterministic single hypothesis from a sealed scorecard (no scraped text). */
export async function proposeFromSealedEpoch(
  opts: ProposeOptions,
): Promise<HarnessHypothesis> {
  const layout = archiveLayout(opts.archiveRoot)
  await ensureArchive(opts.archiveRoot)
  const sealed = loadSealedEpoch(layout, opts.epochId)
  const repoRoot = opts.repoRoot ?? process.cwd()
  const improverConfig = loadImproverConfig(repoRoot)
  const configHash = improverConfigHash(improverConfig)
  const hitThreshold = opts.hitThreshold ?? 0.20

  const weaknessReport = mineWeaknessFromSealedEpoch(
    layout,
    sealed,
    improverConfig,
    hitThreshold,
  )
  const keepSummary = buildKeepSummary(
    layout,
    sealed,
    improverConfig,
    hitThreshold,
  )

  await ensurePriorAttemptsIndex(opts.archiveRoot)
  const priorSummary = buildPriorAttemptsSummary(opts.archiveRoot, {
    nowIso: opts.nowIso,
    maxRecords: 32,
  })

  const fromPatterns = selectFromPatterns(
    weaknessReport.patterns,
    improverConfig.propose.weakMetricPriority,
    improverConfig.propose.maxRationaleChars,
  )
  const fallback = pickWeakMetric(sealed.scorecard)
  const pick = fromPatterns ?? {
    primaryMetric: fallback.primaryMetric,
    rationale: fallback.rationale,
    safetyFloors: fallback.safetyFloors,
    pattern: undefined as HarnessWeaknessPattern | undefined,
  }

  let rationale = pick.rationale
  const nearDup = isNearDuplicateSamePatternLever(
    {
      primaryMetric: pick.primaryMetric,
      ...(pick.pattern ? { weaknessPatternId: pick.pattern.patternId } : {}),
    },
    priorSummary.records,
  )
  if (nearDup) {
    rationale = `${rationale} Note: near-duplicate prior ${nearDup.hypothesisId} on same pattern/lever — manifesto must differ materially.`
      .slice(0, improverConfig.propose.maxRationaleChars)
  }
  const exactDup = isExactDuplicate(
    {},
    priorSummary.records.filter(
      (r) => r.weaknessPatternId === pick.pattern?.patternId
        && r.primaryMetric === pick.primaryMetric,
    ),
  )
  if (exactDup) {
    rationale = `${rationale} Prior exact-pattern attempt ${exactDup.hypothesisId} recorded.`
      .slice(0, improverConfig.propose.maxRationaleChars)
  }

  const weaknessReportHash = sha256Json(weaknessReport as never)
  const keepSummaryHash = sha256Json(keepSummary as never)
  const hypothesisId = `hyp-${opts.epochId}-${createHash("sha256")
    .update(
      pick.primaryMetric
        + sealed.manifest.manifestHash
        + (pick.pattern?.patternId ?? "fallback")
        + weaknessReportHash,
    )
    .digest("hex")
    .slice(0, 12)}`

  const hypothesis = HarnessHypothesisSchema.parse({
    schema: 1,
    hypothesisId,
    createdAt: opts.nowIso,
    epochId: opts.epochId,
    manifestHash: sealed.manifest.manifestHash,
    primaryMetric: pick.primaryMetric,
    safetyFloors: pick.safetyFloors,
    allowlistPaths: [
      "agent/skills/decision-policy/policy.json",
    ],
    sampleRequirements: {
      minEvents: opts.minEvents ?? 40,
      minHoldoutEvents: opts.minHoldoutEvents ?? 20,
    },
    rollbackConditions: [
      "rugExposure exceeds safety floor",
      "paired canary sequential regression",
      "integrity failure during candidate assignment",
      "candidate error budget exhausted",
    ],
    rationale,
    status: "proposed",
    ...(pick.pattern
      ? {
        weaknessPatternId: pick.pattern.patternId,
        evidenceIds: pick.pattern.evidenceIds,
      }
      : {}),
    weaknessReportHash,
    keepSummaryHash,
    improverConfigHash: configHash,
  })

  const dir = hypothesisDir(opts.archiveRoot, hypothesisId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  await saveHypothesis(opts.archiveRoot, hypothesis)
  await writeAtomicFile(
    join(dir, "propose-prompt.txt"),
    `${HARNESS_PROPOSE_PROMPT}\n\nepoch=${opts.epochId}\nmanifest=${sealed.manifest.manifestHash}\n`,
  )
  await writeAtomicFile(
    join(dir, "scorecard-summary.json"),
    `${JSON.stringify({
      epochId: sealed.scorecard.epochId,
      manifestHash: sealed.scorecard.manifestHash,
      hitRate: sealed.scorecard.hitRate,
      ignoreMissRate: sealed.scorecard.ignoreMissRate,
      calibrationBrier: sealed.scorecard.calibrationBrier ?? null,
      paperPnlCostAdjusted: sealed.scorecard.paperPnlCostAdjusted,
      rugExposure: sealed.scorecard.rugExposure,
    }, null, 2)}\n`,
  )
  await writeAtomicFile(
    join(dir, "weakness-report.json"),
    `${JSON.stringify(weaknessReport, null, 2)}\n`,
  )
  await writeAtomicFile(
    join(dir, "keep-summary.json"),
    `${JSON.stringify(keepSummary, null, 2)}\n`,
  )
  await writeAtomicFile(
    join(dir, "prior-attempts-summary.json"),
    `${JSON.stringify(priorSummary, null, 2)}\n`,
  )

  return hypothesis
}

export function hypothesisBindingHash(hypothesis: HarnessHypothesis): `sha256:${string}` {
  return sha256Json({
    hypothesisId: hypothesis.hypothesisId,
    epochId: hypothesis.epochId,
    manifestHash: hypothesis.manifestHash,
    primaryMetric: hypothesis.primaryMetric,
  })
}

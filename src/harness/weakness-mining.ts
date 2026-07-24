import { createHash } from "node:crypto"
import type { ArchiveLayout } from "../lib/archive.js"
import { sha256Json } from "../lib/canonical-json.js"
import {
  CONFIDENCE_BINS,
  HarnessWeaknessReportSchema,
  type ConfidenceBin,
  type HarnessEvidenceRef,
  type HarnessFactor,
  type HarnessFailureMode,
  type HarnessImproverConfig,
  type HarnessStratifier,
  type HarnessWeaknessPattern,
  type HarnessWeaknessReport,
  type OutcomeObservation,
} from "../contracts/schemas.js"
import { loadSealedEpoch, readOutcomeObservation } from "../orchestrator/scorecard.js"
import { loadDecisionBundle } from "../orchestrator/decision-bundle.js"
import { decisionOutcomeToScorecardFields } from "../orchestrator/settle-decisions.js"

export function confidenceBin(confidence: number): ConfidenceBin {
  if (confidence < 20) return "[0,20)"
  if (confidence < 40) return "[20,40)"
  if (confidence < 60) return "[40,60)"
  if (confidence < 80) return "[60,80)"
  return "[80,100]"
}

export function filterAllowlistedSignals(
  signals: Readonly<Record<string, number>>,
  prefixes: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(signals)) {
    if (!Number.isFinite(value)) continue
    const ok = prefixes.some((prefix) =>
      prefix.endsWith(":") ? key.startsWith(prefix) : key === prefix
    )
    if (ok) out[key] = value
  }
  return out
}

export function signalBucket(value: number): string {
  if (!Number.isFinite(value)) return "nan"
  if (Number.isInteger(value) && Math.abs(value) <= 100) return String(value)
  if (value < 0) return "neg"
  if (value === 0) return "0"
  const exp = Math.floor(Math.log10(value))
  return `1e${exp}`
}

function factorKey(factor: HarnessFactor): string {
  if (factor.kind === "confidence_bin") return `confidence_bin=${factor.bin}`
  return `signal:${factor.key}=${factor.bucket}`
}

export function stratifierId(stratifier: HarnessStratifier): string {
  return stratifier.factors.map(factorKey).sort().join("|")
}

export function stratifierLabel(stratifier: HarnessStratifier): string {
  const parts = stratifier.factors.map((f) => {
    if (f.kind === "confidence_bin") return `confidence in ${f.bin}`
    return `${f.key}=${f.bucket}`
  })
  return parts.join(" & ")
}

export function subjectMatchesFactor(
  factor: HarnessFactor,
  confidence: number,
  signals: Readonly<Record<string, number>>,
): boolean {
  if (factor.kind === "confidence_bin") {
    return confidenceBin(confidence) === factor.bin
  }
  const value = signals[factor.key]
  if (value === undefined) return false
  return signalBucket(value) === factor.bucket
}

export function subjectMatchesStratifier(
  stratifier: HarnessStratifier,
  confidence: number,
  signals: Readonly<Record<string, number>>,
): boolean {
  return stratifier.factors.every((f) => subjectMatchesFactor(f, confidence, signals))
}

export function classifyFailureMode(args: Readonly<{
  verdict: string
  confidence: number
  outcome: OutcomeObservation | undefined
  hitThreshold: number
}>): HarnessFailureMode | undefined {
  const { verdict, confidence, outcome, hitThreshold } = args
  if (!outcome) return "outcome-missing"
  if (outcome.status === "terminal-loss") return "rug-terminal-loss"
  if (outcome.status === "provider-pending" || outcome.status === "censored") {
    return "outcome-missing"
  }
  if (outcome.status !== "complete" || outcome.excessReturn === undefined) {
    return "outcome-missing"
  }

  const fields = decisionOutcomeToScorecardFields(
    verdict,
    confidence,
    outcome,
    hitThreshold,
  )
  if (verdict === "track" && fields.hit === false) {
    if (confidence >= 60) return "calibration-miss"
    return "track-miss"
  }
  if (verdict === "ignore" && fields.ignoreWasMiss === true) return "ignore-miss"
  if (verdict === "drop" && fields.dropVindicated === false) {
    return "drop-not-vindicated"
  }
  return undefined
}

function primaryMetricHint(
  mode: HarnessFailureMode,
): HarnessWeaknessPattern["primaryMetricHint"] {
  switch (mode) {
    case "track-miss":
      return "hitRate"
    case "ignore-miss":
      return "ignoreMissRate"
    case "calibration-miss":
      return "calibrationBrier"
    case "rug-terminal-loss":
      return "rugExposure"
    case "drop-not-vindicated":
      return "paperPnlCostAdjusted"
    case "outcome-missing":
      return undefined
  }
}

export function evidenceIdFor(
  subjectId: string,
  horizonHours: number,
  failureMode: HarnessFailureMode,
): string {
  return `ev-${createHash("sha256")
    .update(`${subjectId}:${horizonHours}:${failureMode}`)
    .digest("hex")
    .slice(0, 16)}`
}

function patternIdFor(
  failureMode: HarnessFailureMode,
  stratifier: HarnessStratifier,
): string {
  return `wp-${createHash("sha256")
    .update(`${failureMode}|${stratifierId(stratifier)}`)
    .digest("hex")
    .slice(0, 16)}`
}

type MinedSubject = Readonly<{
  evidence: HarnessEvidenceRef
  confidence: number
  signals: Record<string, number>
  failed: boolean
}>

function buildFactors(
  subjects: readonly MinedSubject[],
  prefixes: readonly string[],
): HarnessFactor[] {
  const factors: HarnessFactor[] = CONFIDENCE_BINS.map((bin) => ({
    kind: "confidence_bin" as const,
    bin,
  }))
  const keyBuckets = new Map<string, Set<string>>()
  for (const subject of subjects) {
    for (const [key, value] of Object.entries(subject.signals)) {
      const allowed = prefixes.some((prefix) =>
        prefix.endsWith(":") ? key.startsWith(prefix) : key === prefix
      )
      if (!allowed || key === "confidence") continue
      let set = keyBuckets.get(key)
      if (!set) {
        set = new Set()
        keyBuckets.set(key, set)
      }
      set.add(signalBucket(value))
    }
  }
  for (const key of [...keyBuckets.keys()].sort()) {
    const buckets = [...(keyBuckets.get(key) ?? [])].sort()
    for (const bucket of buckets.slice(0, 12)) {
      factors.push({ kind: "signal_key", key, bucket })
    }
  }
  return factors
}

function enumerateStratifiers(factors: readonly HarnessFactor[]): HarnessStratifier[] {
  const one: HarnessStratifier[] = factors.map((factor) => ({
    kind: "one_factor",
    factors: [factor],
  }))
  const two: HarnessStratifier[] = []
  for (let i = 0; i < factors.length; i++) {
    for (let j = i + 1; j < factors.length; j++) {
      const a = factors[i]!
      const b = factors[j]!
      if (a.kind === "confidence_bin" && b.kind === "confidence_bin") continue
      two.push({
        kind: "two_factor",
        factors: [a, b].sort((x, y) => factorKey(x).localeCompare(factorKey(y))),
      })
    }
  }
  return [...one, ...two]
}

const FAILURE_MODES: readonly HarnessFailureMode[] = [
  "track-miss",
  "ignore-miss",
  "drop-not-vindicated",
  "calibration-miss",
  "rug-terminal-loss",
  "outcome-missing",
]

export function mineWeaknessFromSealedEpoch(
  layout: ArchiveLayout,
  sealed: ReturnType<typeof loadSealedEpoch>,
  config: HarnessImproverConfig,
  hitThreshold = 0.20,
): HarnessWeaknessReport {
  const prefixes = config.mining.signalKeyPrefixes
  const mined: MinedSubject[] = []

  for (const subject of [...sealed.manifest.subjects].sort((a, b) =>
    a.id.localeCompare(b.id)
  )) {
    if (subject.type !== "decision") continue
    const bundle = loadDecisionBundle(layout, subject.id)
    if (!bundle) continue
    const outcome = readOutcomeObservation(
      layout,
      "decision",
      subject.id,
      subject.horizonHours,
    )
    const failureMode = classifyFailureMode({
      verdict: bundle.card.verdict,
      confidence: bundle.card.confidence,
      outcome,
      hitThreshold,
    })
    const signals = filterAllowlistedSignals(bundle.signals, prefixes)
    const modeForId = failureMode ?? "track-miss"
    const evidence: HarnessEvidenceRef = {
      evidenceId: evidenceIdFor(subject.id, subject.horizonHours, modeForId),
      subjectId: subject.id,
      subjectType: "decision",
      horizonHours: subject.horizonHours,
      failureMode: modeForId,
      signals,
      verdict: bundle.card.verdict,
      outcomeStatus: outcome?.status ?? "absent",
      ...(outcome?.excessReturn !== undefined
        ? { excessReturn: outcome.excessReturn }
        : {}),
      bundleHash: sha256Json({
        decisionId: bundle.decisionId,
        decisionTs: bundle.decisionTs,
        verdict: bundle.card.verdict,
        confidence: bundle.card.confidence,
        signals,
      } as never),
    }
    mined.push({
      evidence,
      confidence: bundle.card.confidence,
      signals,
      failed: failureMode !== undefined,
    })
  }

  const failedSubjects = mined.filter((m) => m.failed)
  const baselineFailureRate = mined.length === 0
    ? 0
    : failedSubjects.length / mined.length
  const factors = buildFactors(failedSubjects, prefixes)
  const stratifiers = enumerateStratifiers(factors)
  const minSupport = config.mining.minClusterSize
  const maxEvidence = config.mining.maxEvidencePerPattern

  const candidates: HarnessWeaknessPattern[] = []

  for (const failureMode of FAILURE_MODES) {
    for (const stratifier of stratifiers) {
      const stratumAll = mined.filter((s) =>
        subjectMatchesStratifier(stratifier, s.confidence, s.signals)
      )
      const stratumFail = stratumAll.filter(
        (s) => s.failed && s.evidence.failureMode === failureMode,
      )
      if (stratumFail.length < minSupport) continue
      const localRate = stratumAll.length === 0
        ? 0
        : stratumFail.length / stratumAll.length
      const localLift = baselineFailureRate > 0
        ? localRate / baselineFailureRate
        : localRate
      const score = localLift * Math.sqrt(stratumFail.length)
      const evidenceIds = stratumFail
        .map((s) => s.evidence.evidenceId)
        .sort()
        .slice(0, maxEvidence)
      const hint = primaryMetricHint(failureMode)
      candidates.push({
        patternId: patternIdFor(failureMode, stratifier),
        failureMode,
        stratifier,
        label: `Associated with ${failureMode} when ${stratifierLabel(stratifier)}`,
        support: stratumFail.length,
        failureCount: stratumFail.length,
        failureRate: localRate,
        baselineFailureRate,
        lift: localLift,
        score,
        evidenceIds,
        ...(hint ? { primaryMetricHint: hint } : {}),
      })
    }
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.patternId.localeCompare(b.patternId)
  })

  const patterns = candidates.slice(0, config.mining.maxClusters)
  const usedEvidenceIds = new Set(patterns.flatMap((p) => p.evidenceIds))
  const evidence = failedSubjects
    .map((s) => s.evidence)
    .filter((e) => usedEvidenceIds.has(e.evidenceId))
    .sort((a, b) => a.evidenceId.localeCompare(b.evidenceId))

  return HarnessWeaknessReportSchema.parse({
    schema: 1,
    epochId: sealed.manifest.epochId,
    manifestHash: sealed.manifest.manifestHash,
    minedAt: sealed.status.sealedAt ?? sealed.scorecard.sealedAt,
    hitThreshold,
    improverConfigHash: sha256Json(config as never),
    totalSubjects: mined.length,
    failedSubjects: failedSubjects.length,
    patterns,
    evidence,
  })
}

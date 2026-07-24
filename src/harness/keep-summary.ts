import { createHash } from "node:crypto"
import type { ArchiveLayout } from "../lib/archive.js"
import { sha256Json } from "../lib/canonical-json.js"
import {
  CONFIDENCE_BINS,
  HarnessKeepSummarySchema,
  type HarnessEvidenceRef,
  type HarnessFactor,
  type HarnessImproverConfig,
  type HarnessKeepPattern,
  type HarnessKeepSummary,
  type HarnessStratifier,
} from "../contracts/schemas.js"
import { loadSealedEpoch, readOutcomeObservation } from "../orchestrator/scorecard.js"
import { loadDecisionBundle } from "../orchestrator/decision-bundle.js"
import { decisionOutcomeToScorecardFields } from "../orchestrator/settle-decisions.js"
import {
  evidenceIdFor,
  filterAllowlistedSignals,
  signalBucket,
  stratifierId,
  stratifierLabel,
  subjectMatchesStratifier,
} from "./weakness-mining.js"

type KeepSubject = Readonly<{
  evidence: HarnessEvidenceRef
  confidence: number
  signals: Record<string, number>
}>

function keepEvidenceId(subjectId: string, horizonHours: number): string {
  return evidenceIdFor(subjectId, horizonHours, "track-miss").replace(/^ev-/u, "ke-")
}

function keepPatternId(stratifier: HarnessStratifier): string {
  return `kp-${createHash("sha256")
    .update(stratifierId(stratifier))
    .digest("hex")
    .slice(0, 16)}`
}

function factorKey(factor: HarnessFactor): string {
  if (factor.kind === "confidence_bin") return `confidence_bin=${factor.bin}`
  return `signal:${factor.key}=${factor.bucket}`
}

function buildFactors(
  subjects: readonly KeepSubject[],
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

/** Host-built keep summary from track+hit decisions in the sealed development epoch */
export function buildKeepSummary(
  layout: ArchiveLayout,
  sealed: ReturnType<typeof loadSealedEpoch>,
  config: HarnessImproverConfig,
  hitThreshold = 0.20,
): HarnessKeepSummary {
  const prefixes = config.mining.signalKeyPrefixes
  const hits: KeepSubject[] = []
  const tracks: KeepSubject[] = []

  for (const subject of [...sealed.manifest.subjects].sort((a, b) =>
    a.id.localeCompare(b.id)
  )) {
    if (subject.type !== "decision") continue
    const bundle = loadDecisionBundle(layout, subject.id)
    if (!bundle || bundle.card.verdict !== "track") continue
    const outcome = readOutcomeObservation(
      layout,
      "decision",
      subject.id,
      subject.horizonHours,
    )
    const fields = decisionOutcomeToScorecardFields(
      bundle.card.verdict,
      bundle.card.confidence,
      outcome,
      hitThreshold,
    )
    const signals = filterAllowlistedSignals(bundle.signals, prefixes)
    const evidence: HarnessEvidenceRef = {
      evidenceId: keepEvidenceId(subject.id, subject.horizonHours),
      subjectId: subject.id,
      subjectType: "decision",
      horizonHours: subject.horizonHours,
      failureMode: "track-miss",
      signals,
      verdict: "track",
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
    const row = {
      evidence,
      confidence: bundle.card.confidence,
      signals,
    }
    tracks.push(row)
    if (fields.hit === true) hits.push(row)
  }

  const factors = buildFactors(hits, prefixes)
  const stratifiers = enumerateStratifiers(factors)
  const minSupport = config.mining.minClusterSize
  const maxPatterns = config.mining.maxKeepPatterns
  const maxEvidence = config.mining.maxEvidencePerPattern

  const candidates: Array<HarnessKeepPattern & { score: number }> = []
  for (const stratifier of stratifiers) {
    const stratumTracks = tracks.filter((s) =>
      subjectMatchesStratifier(stratifier, s.confidence, s.signals)
    )
    const stratumHits = hits.filter((s) =>
      subjectMatchesStratifier(stratifier, s.confidence, s.signals)
    )
    if (stratumHits.length < minSupport) continue
    const hitRate = stratumTracks.length === 0
      ? 0
      : stratumHits.length / stratumTracks.length
    const score = hitRate * Math.sqrt(stratumHits.length)
    candidates.push({
      patternId: keepPatternId(stratifier),
      stratifier,
      label: `Track+hit associated with ${stratifierLabel(stratifier)}`,
      support: stratumHits.length,
      hitRate,
      evidenceIds: stratumHits
        .map((s) => s.evidence.evidenceId)
        .sort()
        .slice(0, maxEvidence),
      score,
    })
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.patternId.localeCompare(b.patternId)
  })

  const patterns = candidates.slice(0, maxPatterns).map(({ score: _s, ...rest }) => rest)
  const used = new Set(patterns.flatMap((p) => p.evidenceIds))
  const evidence = hits
    .map((s) => s.evidence)
    .filter((e) => used.has(e.evidenceId))
    .sort((a, b) => a.evidenceId.localeCompare(b.evidenceId))

  return HarnessKeepSummarySchema.parse({
    schema: 1,
    epochId: sealed.manifest.epochId,
    manifestHash: sealed.manifest.manifestHash,
    builtAt: sealed.status.sealedAt ?? sealed.scorecard.sealedAt,
    hitThreshold,
    improverConfigHash: sha256Json(config as never),
    patterns,
    evidence,
  })
}

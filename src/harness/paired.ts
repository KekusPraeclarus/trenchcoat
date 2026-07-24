import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { sha256Json, type JsonValue } from "../lib/canonical-json.js"
import { canaryStatePath, harnessRoot, loadCanaryState } from "./canary.js"
import {
  HarnessCanaryStateSchema,
  PairedEpisodeRecordSchema,
  SafeIdSchema,
  type PairedEpisodeRecord,
} from "../contracts/schemas.js"
import type { ArchiveLayout } from "../lib/archive.js"
import { readOutcomeObservation } from "../orchestrator/scorecard.js"
import { shouldStopCanary, stopCanary } from "./lifecycle.js"
import { loadConfig } from "../lib/config.js"

export function pairedDir(archiveRoot: string): string {
  return join(harnessRoot(archiveRoot), "paired")
}

export function pairedEpisodePath(archiveRoot: string, episodeId: string): string {
  return join(pairedDir(archiveRoot), `${SafeIdSchema.parse(episodeId)}.json`)
}

/** Canonical hash of a proposal-like object, order independent. */
export function proposalHash(proposal: JsonValue): `sha256:${string}` {
  return sha256Json(proposal)
}

export type RecordPairedInput = Readonly<{
  archiveRoot: string
  episodeId: string
  runId: string
  frozenInboxHash: `sha256:${string}`
  candidatePolicyVersion: string
  baselinePolicyVersion: string
  candidateProposal?: JsonValue
  baselineProposal?: JsonValue
  mature?: boolean
  metricDelta?: Readonly<Record<string, number>>
  recordedAt: string
  decisionIds?: readonly string[]
  horizonHours?: number
}>

/**
 * Record one paired canary episode. Candidate and baseline are decided from the
 * same frozenInboxHash. candidateMutated is derived purely from a hash mismatch
 * between the two proposals, and baselineMutated is always false because the
 * shadow baseline never writes state.
 */
export async function recordPairedEpisode(
  input: RecordPairedInput,
): Promise<PairedEpisodeRecord> {
  const candidateHash = input.candidateProposal !== undefined
    ? proposalHash(input.candidateProposal)
    : undefined
  const baselineHash = input.baselineProposal !== undefined
    ? proposalHash(input.baselineProposal)
    : undefined

  const candidateMutated = candidateHash !== undefined
    && baselineHash !== undefined
    && candidateHash !== baselineHash

  const record = PairedEpisodeRecordSchema.parse({
    schema: 1,
    episodeId: input.episodeId,
    runId: input.runId,
    frozenInboxHash: input.frozenInboxHash,
    candidatePolicyVersion: input.candidatePolicyVersion,
    baselinePolicyVersion: input.baselinePolicyVersion,
    ...(candidateHash ? { candidateProposalHash: candidateHash } : {}),
    ...(baselineHash ? { baselineProposalHash: baselineHash } : {}),
    candidateMutated,
    baselineMutated: false,
    mature: input.mature ?? false,
    metricDelta: input.metricDelta ?? {},
    recordedAt: input.recordedAt,
    ...(input.decisionIds && input.decisionIds.length > 0
      ? { decisionIds: [...input.decisionIds] }
      : {}),
    ...(input.horizonHours !== undefined ? { horizonHours: input.horizonHours } : {}),
  })

  await writeAtomicFile(
    pairedEpisodePath(input.archiveRoot, record.episodeId),
    `${JSON.stringify(record, null, 2)}\n`,
  )
  return record
}

export function loadPairedEpisode(
  archiveRoot: string,
  episodeId: string,
): PairedEpisodeRecord | undefined {
  const path = pairedEpisodePath(archiveRoot, episodeId)
  if (!existsSync(path)) return undefined
  return PairedEpisodeRecordSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

export function listPairedEpisodes(archiveRoot: string): PairedEpisodeRecord[] {
  const dir = pairedDir(archiveRoot)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => PairedEpisodeRecordSchema.parse(
      JSON.parse(readFileSync(join(dir, name), "utf8")),
    ))
}

export function countMaturePaired(archiveRoot: string): number {
  return listPairedEpisodes(archiveRoot).filter((record) => record.mature).length
}

/** Refresh active-canary.json maturePaired from the paired episode store */
export async function maybeBumpCanaryMatureCounts(
  archiveRoot: string,
): Promise<number> {
  const path = canaryStatePath(archiveRoot)
  if (!existsSync(path)) return 0
  const current = HarnessCanaryStateSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  if (!current.active) return current.maturePaired
  const maturePaired = countMaturePaired(archiveRoot)
  if (maturePaired === current.maturePaired) return maturePaired
  const next = HarnessCanaryStateSchema.parse({ ...current, maturePaired })
  await writeAtomicFile(path, `${JSON.stringify(next, null, 2)}\n`)
  return maturePaired
}

/**
 * Mark immature paired episodes mature when their decision outcomes are settled.
 * Then evaluate stop rules and stop the canary if floors breach.
 */
export async function refreshCanaryMaturityAndStops(opts: Readonly<{
  archiveRoot: string
  layout: ArchiveLayout
  nowIso: string
  defaultHorizonHours?: number
}>): Promise<Readonly<{
  matured: number
  stopped: boolean
  stopReason?: string
}>> {
  const state = loadCanaryState(opts.archiveRoot)
  if (!state?.active) return { matured: 0, stopped: false }

  const horizonDefault = opts.defaultHorizonHours ?? 72
  let matured = 0
  let sequentialRegressions = 0
  let rugNum = 0
  let rugDen = 0
  let missingNum = 0
  let missingDen = 0
  const candidateErrors = 0

  for (const episode of listPairedEpisodes(opts.archiveRoot)) {
    if (episode.candidatePolicyVersion !== state.policyVersion) continue
    const decisionIds = episode.decisionIds ?? []
    const horizon = episode.horizonHours ?? horizonDefault
    missingDen += Math.max(1, decisionIds.length)

    if (episode.mature) {
      const delta = episode.metricDelta["primary"] ?? 0
      if (delta < 0) sequentialRegressions += 1
      else sequentialRegressions = 0
      for (const id of decisionIds) {
        const obs = readOutcomeObservation(opts.layout, "decision", id, horizon)
        rugDen += 1
        if (obs?.status === "terminal-loss") rugNum += 1
        if (!obs || obs.status === "provider-pending" || obs.status === "censored") {
          missingNum += 1
        }
      }
      continue
    }

    if (decisionIds.length === 0) continue
    const outcomes = decisionIds.map((id) =>
      readOutcomeObservation(opts.layout, "decision", id, horizon)
    )
    const allSettled = outcomes.every(
      (o) => o && (o.status === "complete" || o.status === "terminal-loss"),
    )
    if (!allSettled) {
      missingNum += outcomes.filter(
        (o) => !o || o.status === "provider-pending" || o.status === "censored",
      ).length
      continue
    }

    const excesses = outcomes
      .map((o) => o!.excessReturn)
      .filter((n): n is number => n !== undefined)
    const meanExcess = excesses.length === 0
      ? 0
      : excesses.reduce((a, b) => a + b, 0) / excesses.length
    const rugs = outcomes.filter((o) => o!.status === "terminal-loss").length
    rugNum += rugs
    rugDen += outcomes.length

    const updated = PairedEpisodeRecordSchema.parse({
      ...episode,
      mature: true,
      metricDelta: {
        ...episode.metricDelta,
        primary: meanExcess,
        rugCount: rugs,
      },
      recordedAt: opts.nowIso,
    })
    await writeAtomicFile(
      pairedEpisodePath(opts.archiveRoot, episode.episodeId),
      `${JSON.stringify(updated, null, 2)}\n`,
    )
    matured += 1
    if (meanExcess < 0) sequentialRegressions += 1
    else sequentialRegressions = 0
  }

  await maybeBumpCanaryMatureCounts(opts.archiveRoot)

  let cfg: Readonly<{
    rug_exposure_max: number
    error_budget: number
    missingness_max: number
  }>
  try {
    cfg = loadConfig().harness_improvement
  } catch {
    cfg = {
      rug_exposure_max: 0.25,
      error_budget: 3,
      missingness_max: 0.3,
    }
  }

  const rugExposure = rugDen === 0 ? 0 : rugNum / rugDen
  const missingness = missingDen === 0 ? 0 : missingNum / missingDen
  const stop = shouldStopCanary({
    rugExposure,
    rugFloor: cfg.rug_exposure_max,
    candidateErrors,
    errorBudget: cfg.error_budget,
    missingness,
    missingnessMax: cfg.missingness_max,
    sequentialRegressions,
    integrityFailure: false,
  })

  if (stop.shouldStop && stop.reason) {
    await stopCanary({
      archiveRoot: opts.archiveRoot,
      reason: stop.reason,
      nowIso: opts.nowIso,
      rollbackHypothesis: true,
    })
    return { matured, stopped: true, stopReason: stop.reason }
  }

  return { matured, stopped: false }
}

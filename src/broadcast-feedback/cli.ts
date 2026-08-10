import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import {
  DecisionPolicyDocumentSchema,
  type DecisionPolicyDocument,
  type FeedbackCandidate,
  type SealedFeedbackDataset,
} from "../contracts/schemas.js"
import { loadBroadcastOutputTuning } from "../orchestrator/broadcast-output-tuning.js"
import {
  checkSealFloors,
  readSealedDataset,
  sealFeedbackDataset,
  writeSealedDataset,
  type DecisionSignalLookup,
  type PolicyVerdictLookup,
} from "./aggregate.js"
import {
  applyFeedbackCandidate,
  buildFeedbackCandidate,
  dismissFeedbackCandidate,
  readCandidate,
  writeCandidate,
  type MarketHoldoutReplay,
} from "./candidate.js"
import { expireStaleFollowups } from "./followup.js"
import { broadcastFeedbackLayout, type BroadcastFeedbackLayout } from "./paths.js"
import {
  buildOperatorPreferenceSet,
  signalsFromExamples,
  writeActivePreferenceSet,
} from "./policy-preferences.js"
import { currentFeedbackRecords, readPendingFollowups } from "./store.js"

/**
 * Operator commands for broadcast feedback (ADR 043). Every command is manual.
 * Nothing here commits, pushes, deploys, or activates.
 */

export type FeedbackCliDeps = Readonly<{
  layout?: BroadcastFeedbackLayout
  repoRoot: string
  nowIso: string
  signals: DecisionSignalLookup
  verdicts: PolicyVerdictLookup
  replayMarketHoldout?: MarketHoldoutReplay
  floors: Readonly<{
    minPolicyExamples: number
    minCompletedDown: number
    minPreferencePairs: number
  }>
}>

function layoutOf(deps: FeedbackCliDeps): BroadcastFeedbackLayout {
  return deps.layout ?? broadcastFeedbackLayout()
}

export function feedbackStatus(deps: FeedbackCliDeps): Readonly<{
  records: number
  up: number
  down: number
  ambiguous: number
  completedDown: number
  pending: number
  latestDatasetId?: string
  latestCandidateId?: string
}> {
  const layout = layoutOf(deps)
  const records = currentFeedbackRecords(layout)
  const datasets = listSealedDatasets(layout)
  const candidates = listCandidates(layout)
  const latestDataset = datasets[datasets.length - 1]
  const latestCandidate = candidates[candidates.length - 1]
  return {
    records: records.length,
    up: records.filter((r) => r.state === "up").length,
    down: records.filter((r) => r.state === "down").length,
    ambiguous: records.filter((r) => r.state === "ambiguous").length,
    completedDown: records.filter(
      (r) => r.state === "down" && r.followupStatus === "completed",
    ).length,
    pending: readPendingFollowups(layout).pending.length,
    ...(latestDataset ? { latestDatasetId: latestDataset.datasetId } : {}),
    ...(latestCandidate ? { latestCandidateId: latestCandidate.candidateId } : {}),
  }
}

export function listSealedDatasets(
  layout: BroadcastFeedbackLayout,
): readonly SealedFeedbackDataset[] {
  if (!existsSync(layout.sealed)) return []
  return readdirSync(layout.sealed)
    .filter((name) => name.endsWith(".json") && name.startsWith("fbds-"))
    .sort()
    .flatMap((name) => {
      try {
        return [readSealedDataset(join(layout.sealed, name))]
      } catch {
        return []
      }
    })
}

export function listCandidates(
  layout: BroadcastFeedbackLayout,
): readonly FeedbackCandidate[] {
  if (!existsSync(layout.candidates)) return []
  return readdirSync(layout.candidates)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      const candidate = readCandidate(layout, name.replace(/\.json$/u, ""))
      return candidate ? [candidate] : []
    })
}

export function feedbackLedgerView(deps: FeedbackCliDeps): readonly Readonly<{
  feedbackId: string
  state: string
  followupStatus: string
  subject?: string
  tags: readonly string[]
}>[] {
  return currentFeedbackRecords(layoutOf(deps)).map((record) => ({
    feedbackId: record.feedbackId,
    state: record.state,
    followupStatus: record.followupStatus,
    ...(record.subject ? { subject: record.subject } : {}),
    tags: record.tags,
  }))
}

export type SealOutcome =
  | Readonly<{ ok: true; dataset: SealedFeedbackDataset; path: string }>
  | Readonly<{ ok: false; misses: readonly string[]; dataset: SealedFeedbackDataset }>

export function feedbackSeal(deps: FeedbackCliDeps): SealOutcome {
  const layout = layoutOf(deps)
  const dataset = sealFeedbackDataset({
    layout,
    signals: deps.signals,
    verdicts: deps.verdicts,
    nowIso: deps.nowIso,
  })
  const misses = checkSealFloors({ dataset, floors: deps.floors })
  if (misses.length > 0) return { ok: false, misses, dataset }
  const path = writeSealedDataset(layout, dataset)
  writeActivePreferenceSet({
    layout,
    set: buildOperatorPreferenceSet({
      dataset,
      signalsByEvent: signalsFromExamples(dataset.policyExamples),
    }),
  })
  return { ok: true, dataset, path }
}

export function loadBaselinePolicy(repoRoot: string): DecisionPolicyDocument {
  const path = join(repoRoot, "agent/skills/decision-policy/policy.json")
  return DecisionPolicyDocumentSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

export type CandidateOutcome = Readonly<{
  candidate: FeedbackCandidate
  confinementReasons: readonly string[]
  path?: string
}>

export function feedbackCandidate(deps: FeedbackCliDeps & Readonly<{
  datasetId?: string
}>): CandidateOutcome {
  const layout = layoutOf(deps)
  const datasets = listSealedDatasets(layout)
  const dataset = deps.datasetId
    ? datasets.find((entry) => entry.datasetId === deps.datasetId)
    : datasets[datasets.length - 1]
  if (!dataset) throw new Error("no sealed dataset — run broadcast feedback seal first")

  const built = buildFeedbackCandidate({
    dataset,
    baseline: loadBaselinePolicy(deps.repoRoot),
    tuning: loadBroadcastOutputTuning(deps.repoRoot),
    nowIso: deps.nowIso,
    ...(deps.replayMarketHoldout
      ? { replayMarketHoldout: deps.replayMarketHoldout }
      : {}),
  })
  const confinementReasons = built.confinement.ok ? [] : built.confinement.reasons
  if (confinementReasons.length > 0) {
    return { candidate: built.candidate, confinementReasons }
  }
  const path = writeCandidate(layout, built.candidate)
  return { candidate: built.candidate, confinementReasons, path }
}

export function feedbackApply(deps: FeedbackCliDeps & Readonly<{
  candidateId: string
}>): readonly string[] {
  const layout = layoutOf(deps)
  const candidate = readCandidate(layout, deps.candidateId)
  if (!candidate) throw new Error(`unknown candidate ${deps.candidateId}`)
  return applyFeedbackCandidate({
    repoRoot: deps.repoRoot,
    candidate,
    layout,
    nowIso: deps.nowIso,
  })
}

export function feedbackDismiss(deps: FeedbackCliDeps & Readonly<{
  candidateId: string
}>): FeedbackCandidate {
  const layout = layoutOf(deps)
  const candidate = readCandidate(layout, deps.candidateId)
  if (!candidate) throw new Error(`unknown candidate ${deps.candidateId}`)
  return dismissFeedbackCandidate({ layout, candidate, nowIso: deps.nowIso })
}

/** Expire stale detail requests; reaction reconcile lives in the Discord listener */
export async function feedbackReconcile(deps: FeedbackCliDeps): Promise<number> {
  return expireStaleFollowups({ layout: layoutOf(deps), nowIso: deps.nowIso })
}

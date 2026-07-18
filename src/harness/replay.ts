import type { ArchiveLayout } from "../lib/archive.js"
import { computeScorecard, readOutcomeObservation } from "../orchestrator/scorecard.js"
import type {
  DecisionPolicyDocument,
  OutcomeObservation,
  Scorecard,
} from "../contracts/schemas.js"
import { interpretPolicy } from "./policy.js"

export type ReplaySubject = Readonly<{
  subjectId: string
  subjectType: OutcomeObservation["subjectType"]
  horizonHours: number
  signals: Readonly<Record<string, number>>
  // inline sealed outcome, else loaded from the sealed outcome store via layout
  outcome?: OutcomeObservation
}>

export type ReplayInput = Readonly<{
  epochId: string
  sealedAt: string
  manifestHash: `sha256:${string}`
  policy: DecisionPolicyDocument
  subjects: readonly ReplaySubject[]
  layout?: ArchiveLayout
}>

type DecisionRow = {
  verdict: string
  confidence: number
  hit?: boolean
  excess72h?: number
  dropVindicated?: boolean
  ignoreWasMiss?: boolean
}

function resolveOutcome(
  input: ReplayInput,
  subject: ReplaySubject,
): OutcomeObservation | undefined {
  if (subject.outcome) return subject.outcome
  if (!input.layout) return undefined
  return readOutcomeObservation(
    input.layout,
    subject.subjectType,
    subject.subjectId,
    subject.horizonHours,
  )
}

/**
 * Re-decide sealed holdout subjects through a candidate policy and fold the
 * verdicts against the sealed outcomes into a fresh scorecard.
 *
 * This never reads the holdout's own sealed scorecard, so the candidate metric
 * measures the policy under test rather than the graded baseline of the epoch.
 */
export function replayHoldoutThroughPolicy(input: ReplayInput): Scorecard {
  const decisions: DecisionRow[] = []
  const outcomesForCoverage: { status: string }[] = []
  const rugs: { rug: boolean }[] = []
  let paperPnlGross = 0
  let paperPnlCostAdjusted = 0

  for (const subject of input.subjects) {
    const outcome = resolveOutcome(input, subject)
    const verdict = interpretPolicy(input.policy, {
      subjectId: subject.subjectId,
      signals: subject.signals,
    })

    const resolved = outcome?.status === "complete" || outcome?.status === "terminal-loss"
    const excess = outcome?.excessReturn
    const raw = outcome?.rawReturn
    const good = resolved && excess !== undefined && excess > 0
    const rug = outcome?.status === "terminal-loss"

    const row: DecisionRow = { verdict: verdict.verdict, confidence: verdict.confidence }
    if (resolved && excess !== undefined) {
      if (verdict.verdict === "track") {
        row.hit = good
        row.excess72h = excess
        paperPnlGross += raw ?? 0
        paperPnlCostAdjusted += excess
      } else if (verdict.verdict === "drop") {
        row.dropVindicated = !good
      } else if (verdict.verdict === "ignore") {
        row.ignoreWasMiss = good
      }
    }
    decisions.push(row)
    outcomesForCoverage.push({ status: outcome?.status ?? "provider-pending" })
    rugs.push({ rug })
  }

  return computeScorecard({
    epochId: input.epochId,
    sealedAt: input.sealedAt,
    manifestHash: input.manifestHash,
    decisions,
    broadcasts: [],
    sourceCalls: [],
    outcomes: outcomesForCoverage,
    rugs,
    paperPnlGross,
    paperPnlCostAdjusted,
  })
}

import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { repoMutationLockPath } from "../chain-integration/paths.js"
import { WorkspaceLock } from "../lib/lock.js"
import {
  BroadcastOutputTuningSchema,
  DecisionPolicyDocumentSchema,
  FeedbackCandidateSchema,
  FEEDBACK_CANDIDATE_ALLOWED_PATHS,
  type BroadcastOutputTuning,
  type DecisionPolicyDocument,
  type FeedbackCandidate,
  type FeedbackPolicyEvaluation,
  type FeedbackPolicyExample,
  type OperatorPreferenceSet,
  type SealedFeedbackDataset,
} from "../contracts/schemas.js"
import { preferenceAgreement } from "../harness/operator-preference.js"
import { broadcastFeedbackLayout, type BroadcastFeedbackLayout } from "./paths.js"
import { buildOperatorPreferenceSet, signalsFromExamples } from "./policy-preferences.js"

/**
 * Manual, confined tuning candidates from sealed operator feedback (ADR 043).
 * A candidate may touch exactly two literal paths, carries bounded deltas, and
 * never commits, pushes, deploys, or activates anything.
 */

export const MAX_WEIGHT_DELTA = 0.25
export const MAX_THRESHOLD_DELTA = 0.10
export const MAX_CHANGED_RULES = 4
export const MIN_DEVELOPMENT_AGREEMENT_GAIN = 0.10

/** One weight step per candidate; several candidates can compound over time */
const WEIGHT_STEP = 0.05

/** Signal keys must start with one of these, so a candidate cannot invent features */
export const DEFAULT_KNOWN_SIGNAL_PREFIXES: readonly string[] = Object.freeze([
  "market.",
  "social.",
  "source.",
  "wallet.",
  "narrative.",
  "risk.",
])

export function hasKnownSignalPrefix(
  key: string,
  prefixes: readonly string[] = DEFAULT_KNOWN_SIGNAL_PREFIXES,
): boolean {
  return prefixes.some((prefix) => key.startsWith(prefix))
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export type PolicyAdjustment = Readonly<{
  weights: Readonly<Record<string, number>>
  changedKeys: readonly string[]
}>

/**
 * Nudge the weights of signals that separate corrected broadcasts from
 * approved ones. The direction is deterministic and the step is fixed, so a
 * reviewer can predict every delta from the dataset.
 */
export function proposePolicyAdjustment(args: Readonly<{
  policy: DecisionPolicyDocument
  examples: readonly FeedbackPolicyExample[]
  knownPrefixes?: readonly string[]
}>): PolicyAdjustment {
  const prefixes = args.knownPrefixes ?? DEFAULT_KNOWN_SIGNAL_PREFIXES
  const development = args.examples.filter((example) => example.split === "development")
  const approvals = development.filter((example) => example.polarity === "approval")
  const corrections = development.filter((example) => example.polarity === "correction")
  if (corrections.length === 0) {
    return { weights: args.policy.weights, changedKeys: [] }
  }

  const keys = [...new Set(development.flatMap((e) => Object.keys(e.signals)))]
    .filter((key) => hasKnownSignalPrefix(key, prefixes))
    .sort()

  const scored = keys.map((key) => ({
    key,
    gap: mean(corrections.map((e) => e.signals[key] ?? 0))
      - mean(approvals.map((e) => e.signals[key] ?? 0)),
  })).filter((entry) => entry.gap !== 0)

  const selected = [...scored]
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap) || a.key.localeCompare(b.key))
    .slice(0, MAX_CHANGED_RULES)

  const weights = { ...args.policy.weights }
  const changedKeys: string[] = []
  for (const entry of selected) {
    const base = weights[entry.key] ?? 0
    const delta = entry.gap > 0 ? -WEIGHT_STEP : WEIGHT_STEP
    weights[entry.key] = Number((base + delta).toFixed(4))
    changedKeys.push(entry.key)
  }
  return { weights, changedKeys: changedKeys.sort() }
}

export type ConfinementResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reasons: readonly string[] }>

export function checkCandidateConfinement(args: Readonly<{
  baseline: DecisionPolicyDocument
  candidate: DecisionPolicyDocument
  changedPaths: readonly string[]
  knownPrefixes?: readonly string[]
}>): ConfinementResult {
  const reasons: string[] = []
  for (const path of args.changedPaths) {
    if (!(FEEDBACK_CANDIDATE_ALLOWED_PATHS as readonly string[]).includes(path)) {
      reasons.push(`path-not-allowed:${path}`)
    }
  }

  const keys = new Set([
    ...Object.keys(args.baseline.weights),
    ...Object.keys(args.candidate.weights),
  ])
  let changed = 0
  for (const key of [...keys].sort()) {
    const before = args.baseline.weights[key] ?? 0
    const after = args.candidate.weights[key] ?? 0
    if (before === after) continue
    changed += 1
    if (!hasKnownSignalPrefix(key, args.knownPrefixes)) {
      reasons.push(`unknown-signal:${key}`)
    }
    if (Math.abs(after - before) > MAX_WEIGHT_DELTA + 1e-9) {
      reasons.push(`weight-delta:${key}`)
    }
  }
  if (changed > MAX_CHANGED_RULES) reasons.push("too-many-changed-rules")

  const thresholdKeys = new Set([
    ...Object.keys(args.baseline.thresholds),
    ...Object.keys(args.candidate.thresholds),
  ])
  for (const key of [...thresholdKeys].sort()) {
    const before = args.baseline.thresholds[key] ?? 0
    const after = args.candidate.thresholds[key] ?? 0
    if (Math.abs(after - before) > MAX_THRESHOLD_DELTA + 1e-9) {
      reasons.push(`threshold-delta:${key}`)
    }
  }

  if (args.candidate.rules.length !== args.baseline.rules.length) {
    reasons.push("rule-count-changed")
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}

/** Same deterministic quarter split as the policy examples */
export function splitPreferenceSet(
  set: OperatorPreferenceSet,
): Readonly<{ development: OperatorPreferenceSet; holdout: OperatorPreferenceSet }> {
  const ranked = [...set.pairs].sort((a, b) => a.pairId.localeCompare(b.pairId))
  const development = ranked.filter((_, index) => index % 4 !== 3)
  const holdout = ranked.filter((_, index) => index % 4 === 3)
  return {
    development: { ...set, pairs: development },
    holdout: { ...set, pairs: holdout },
  }
}

export type MarketHoldoutReplay = (args: Readonly<{
  policy: DecisionPolicyDocument
}>) => Readonly<{
  ok: boolean
  epochId?: string
  protectedMetricsPass: boolean
  reason?: string
}>

export function evaluateFeedbackCandidate(args: Readonly<{
  dataset: SealedFeedbackDataset
  baseline: DecisionPolicyDocument
  candidate: DecisionPolicyDocument
  replayMarketHoldout?: MarketHoldoutReplay
}>): FeedbackPolicyEvaluation {
  const set = buildOperatorPreferenceSet({
    dataset: args.dataset,
    signalsByEvent: signalsFromExamples(args.dataset.policyExamples),
  })
  const split = splitPreferenceSet(set)
  const developmentBefore = preferenceAgreement({
    policy: args.baseline,
    set: split.development,
  }).agreement
  const developmentAfter = preferenceAgreement({
    policy: args.candidate,
    set: split.development,
  }).agreement
  const holdoutBefore = preferenceAgreement({
    policy: args.baseline,
    set: split.holdout,
  }).agreement
  const holdoutAfter = preferenceAgreement({
    policy: args.candidate,
    set: split.holdout,
  }).agreement

  const failReasons: string[] = []
  if (developmentAfter - developmentBefore < MIN_DEVELOPMENT_AGREEMENT_GAIN - 1e-9) {
    failReasons.push("development-agreement-gain")
  }
  if (holdoutAfter < holdoutBefore - 1e-9) failReasons.push("holdout-preference-regression")

  const replay = args.replayMarketHoldout?.({ policy: args.candidate })
  const protectedMetricsPass = replay?.protectedMetricsPass ?? false
  if (!replay) failReasons.push("market-holdout-missing")
  else if (!replay.ok) failReasons.push(`market-holdout:${replay.reason ?? "failed"}`)
  else if (!replay.protectedMetricsPass) failReasons.push("protected-metrics")

  return {
    schema: 1,
    developmentAgreementBefore: developmentBefore,
    developmentAgreementAfter: developmentAfter,
    holdoutAgreementBefore: holdoutBefore,
    holdoutAgreementAfter: holdoutAfter,
    ...(replay?.epochId ? { marketHoldoutEpochId: replay.epochId } : {}),
    protectedMetricsPass,
    pass: failReasons.length === 0,
    failReasons,
  }
}

export function candidatePath(
  layout: BroadcastFeedbackLayout,
  candidateId: string,
): string {
  return join(layout.candidates, `${candidateId}.json`)
}

export function writeCandidate(
  layout: BroadcastFeedbackLayout,
  candidate: FeedbackCandidate,
): string {
  mkdirSync(layout.candidates, { recursive: true, mode: 0o700 })
  const path = candidatePath(layout, candidate.candidateId)
  writeFileSync(path, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 })
  return path
}

export function readCandidate(
  layout: BroadcastFeedbackLayout,
  candidateId: string,
): FeedbackCandidate | undefined {
  const path = candidatePath(layout, candidateId)
  if (!existsSync(path)) return undefined
  try {
    return FeedbackCandidateSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return undefined
  }
}

export function buildFeedbackCandidate(args: Readonly<{
  dataset: SealedFeedbackDataset
  baseline: DecisionPolicyDocument
  tuning: BroadcastOutputTuning
  nowIso: string
  replayMarketHoldout?: MarketHoldoutReplay
  knownPrefixes?: readonly string[]
}>): Readonly<{
  candidate: FeedbackCandidate
  confinement: ConfinementResult
}> {
  const adjustment = proposePolicyAdjustment({
    policy: args.baseline,
    examples: args.dataset.policyExamples,
    ...(args.knownPrefixes ? { knownPrefixes: args.knownPrefixes } : {}),
  })
  const policyDocument = DecisionPolicyDocumentSchema.parse({
    ...args.baseline,
    kind: "candidate",
    policyVersion: `fb-${createHash("sha256")
      .update(`${args.dataset.datasetId}|${adjustment.changedKeys.join(",")}`)
      .digest("hex").slice(0, 12)}`,
    createdAt: args.nowIso,
    weights: adjustment.weights,
  })
  const changedPaths = [
    ...(adjustment.changedKeys.length > 0
      ? ["agent/skills/decision-policy/policy.json" as const]
      : []),
    "config/broadcast-output-tuning.json" as const,
  ]
  const confinement = checkCandidateConfinement({
    baseline: args.baseline,
    candidate: policyDocument,
    changedPaths,
    ...(args.knownPrefixes ? { knownPrefixes: args.knownPrefixes } : {}),
  })
  const evaluation = evaluateFeedbackCandidate({
    dataset: args.dataset,
    baseline: args.baseline,
    candidate: policyDocument,
    ...(args.replayMarketHoldout ? { replayMarketHoldout: args.replayMarketHoldout } : {}),
  })
  const candidate = FeedbackCandidateSchema.parse({
    schema: 1,
    candidateId: `fbc-${randomUUID().slice(0, 12)}`,
    createdAt: args.nowIso,
    datasetId: args.dataset.datasetId,
    status: "proposed",
    changedPaths,
    rationale: renderRationale(args.dataset, adjustment),
    outputTuning: BroadcastOutputTuningSchema.parse(args.tuning),
    ...(adjustment.changedKeys.length > 0 ? { policyDocument } : {}),
    evaluation,
  })
  return { candidate, confinement }
}

function renderRationale(
  dataset: SealedFeedbackDataset,
  adjustment: PolicyAdjustment,
): string {
  const tags = Object.entries(dataset.tagCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, count]) => `${tag}=${count}`)
    .join(" ")
  return [
    `dataset ${dataset.datasetId}`,
    `up=${dataset.counts.up} completedDown=${dataset.counts.completedDown}`,
    `pairs=${dataset.counts.preferencePairs} examples=${dataset.counts.policyExamples}`,
    adjustment.changedKeys.length > 0
      ? `weights changed: ${adjustment.changedKeys.join(", ")}`
      : "no weight change",
    tags.length > 0 ? `tags: ${tags}` : "tags: none",
  ].join(" · ").slice(0, 1_000)
}

export class FeedbackApplyError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "FeedbackApplyError"
    this.code = code
  }
}

function git(cwd: string, args: readonly string[]): { status: number; stdout: string } {
  const out = spawnSync("git", [...args], { cwd, encoding: "utf8" })
  return { status: out.status ?? 1, stdout: (out.stdout ?? "").trim() }
}

/**
 * Write the candidate into the checkout. The operator reviews, tests, commits,
 * and deploys by hand; this function never runs git beyond the clean check.
 */
export function applyFeedbackCandidate(args: Readonly<{
  repoRoot: string
  candidate: FeedbackCandidate
  layout?: BroadcastFeedbackLayout
  nowIso: string
}>): readonly string[] {
  const layout = args.layout ?? broadcastFeedbackLayout()
  if (args.candidate.status !== "proposed") {
    throw new FeedbackApplyError("not-proposed", `candidate is ${args.candidate.status}`)
  }
  if (!args.candidate.evaluation?.pass) {
    throw new FeedbackApplyError("evaluation-failed", "candidate did not pass evaluation")
  }
  for (const path of args.candidate.changedPaths) {
    if (!(FEEDBACK_CANDIDATE_ALLOWED_PATHS as readonly string[]).includes(path)) {
      throw new FeedbackApplyError("path-not-allowed", path)
    }
  }

  const status = git(args.repoRoot, ["status", "--porcelain"])
  if (status.status !== 0) {
    throw new FeedbackApplyError("git-failed", "git status failed")
  }
  if (status.stdout.length > 0) {
    throw new FeedbackApplyError("dirty-worktree", "repository is not clean")
  }

  const lock = new WorkspaceLock(repoMutationLockPath())
  if (!lock.tryAcquire()) {
    throw new FeedbackApplyError("mutation-lock", "repo mutation lock held")
  }
  const written: string[] = []
  try {
    for (const path of args.candidate.changedPaths) {
      if (path === "agent/skills/decision-policy/policy.json") {
        if (!args.candidate.policyDocument) continue
        writeFileSync(
          join(args.repoRoot, path),
          `${JSON.stringify(args.candidate.policyDocument, null, 2)}\n`,
        )
      } else {
        writeFileSync(
          join(args.repoRoot, path),
          `${JSON.stringify({
            ...(args.candidate.outputTuning ?? {
              schema: 1,
              updatedAt: args.nowIso,
              copyGuidance: [],
              worthinessGuidance: [],
            }),
            updatedAt: args.nowIso,
            sourceCandidateId: args.candidate.candidateId,
          }, null, 2)}\n`,
        )
      }
      written.push(path)
    }
  } finally {
    lock.release()
  }

  writeCandidate(layout, {
    ...args.candidate,
    status: "applied",
    appliedAt: args.nowIso,
  })
  return written
}

export function dismissFeedbackCandidate(args: Readonly<{
  layout?: BroadcastFeedbackLayout
  candidate: FeedbackCandidate
  nowIso: string
}>): FeedbackCandidate {
  const layout = args.layout ?? broadcastFeedbackLayout()
  const dismissed = FeedbackCandidateSchema.parse({
    ...args.candidate,
    status: "dismissed",
    dismissedAt: args.nowIso,
  })
  writeCandidate(layout, dismissed)
  return dismissed
}

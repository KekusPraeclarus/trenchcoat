import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ensureArchive, type ArchiveLayout } from "../../src/lib/archive.js"
import {
  beginEpochBuild,
  computeScorecard,
  planAuditEpoch,
  sealEpoch,
  writeDecisionBundle,
  writeOutcomeObservation,
} from "../../src/orchestrator/scorecard.js"
import {
  DecisionBundleSchema,
  OutcomeObservationSchema,
  type DecisionBundle,
} from "../../src/contracts/schemas.js"

const CONFIG_HASH = `sha256:${"b".repeat(64)}` as const

export async function sealScorecardEpoch(opts: Readonly<{
  archiveRoot: string
  epochId: string
  hits?: number
  subjects?: ReadonlyArray<{ id: string; horizonHours?: number }>
}>): Promise<void> {
  const layout = await ensureArchive(opts.archiveRoot)
  const subjects = (opts.subjects ?? [{ id: "decision-1" }]).map((s) => ({
    id: s.id,
    type: "decision" as const,
    eventTimestamp: 1_000,
    horizonHours: s.horizonHours ?? 24,
  }))
  const manifest = planAuditEpoch({
    epochId: opts.epochId,
    previousEpochId: null,
    startedAt: 400_000,
    cutoffTimestamp: 350_000,
    settlementDelayHours: 6,
    priorSourceScoreCutoff: 90_000,
    configHash: CONFIG_HASH,
    featureSpecVersion: 1,
    executionModelVersion: 1,
    codeCommit: "abcdef1",
    subjects,
  })
  await beginEpochBuild(layout, manifest)
  const hits = opts.hits ?? 4
  const decisions = Array.from({ length: 10 }, (_, i) => ({
    verdict: "track",
    confidence: 60,
    hit: i < hits,
    excess72h: i < hits ? 0.25 : 0,
  }))
  const scorecard = computeScorecard({
    epochId: opts.epochId,
    sealedAt: "2026-07-16T00:00:00.000Z",
    manifestHash: manifest.manifestHash,
    decisions,
    broadcasts: [],
    sourceCalls: [],
    outcomes: Array.from({ length: 10 }, () => ({ status: "complete" })),
    rugs: Array.from({ length: 10 }, () => ({ rug: false })),
    paperPnlGross: 10,
    paperPnlCostAdjusted: 8,
  })
  await sealEpoch(layout, opts.epochId, scorecard, "2026-07-16T00:00:00.000Z")
}

export function makeDecisionBundle(opts: Readonly<{
  decisionId: string
  verdict?: "track" | "drop" | "ignore" | "revisit"
  confidence?: number
  signals?: Record<string, number>
  withIdentity?: boolean
}>): DecisionBundle {
  return DecisionBundleSchema.parse({
    schema: 1,
    decisionId: opts.decisionId,
    runId: "run-1",
    decisionTs: "2026-07-10T00:00:00.000Z",
    card: {
      decisionId: opts.decisionId,
      runId: "run-1",
      decisionTs: "2026-07-10T00:00:00.000Z",
      verdict: opts.verdict ?? "track",
      confidence: opts.confidence ?? 55,
      horizonHours: 72,
      thesis: "IGNORE — must never enter mining",
      drivers: ["IGNORE"],
      countercase: "IGNORE",
      gate: "IGNORE",
      invalidation: "IGNORE",
      clusters: 1,
      signalUse: {},
      sources: [],
      policyVersion: "baseline",
      assignment: "baseline",
      ...(opts.withIdentity !== false
        ? {
            identity: {
              chain: "solana",
              tokenAddress: "So11111111111111111111111111111111111111112",
              pairAddress: "So11111111111111111111111111111111111111112",
              symbolDisplay: "TEST",
              resolution: "resolved",
            },
          }
        : {}),
    },
    provenanceIds: [],
    inboxManifestHash: `sha256:${"1".repeat(64)}`,
    sourceScoresSnapshotHash: `sha256:${"2".repeat(64)}`,
    marketBlobRefs: [],
    runConfigHash: `sha256:${"3".repeat(64)}`,
    policyVersion: "baseline",
    assignment: "baseline",
    signals: opts.signals ?? { confidence: opts.confidence ?? 55, clusters: 1 },
  })
}

export async function seedDecisionWithOutcome(opts: Readonly<{
  layout: ArchiveLayout
  decisionId: string
  verdict?: "track" | "drop" | "ignore"
  confidence?: number
  excessReturn: number
  status?: "complete" | "terminal-loss"
  signals?: Record<string, number>
}>): Promise<void> {
  const bundle = makeDecisionBundle({
    decisionId: opts.decisionId,
    ...(opts.verdict ? { verdict: opts.verdict } : {}),
    ...(opts.confidence !== undefined ? { confidence: opts.confidence } : {}),
    ...(opts.signals ? { signals: opts.signals } : {}),
  })
  await writeDecisionBundle(opts.layout, bundle)
    await writeOutcomeObservation(
    opts.layout,
    OutcomeObservationSchema.parse({
      schema: 1,
      subjectType: "decision",
      subjectId: opts.decisionId,
      horizonHours: 24,
      observationSpecVersion: 1,
      status: opts.status ?? "complete",
      eventTs: bundle.decisionTs,
      excessReturn: opts.excessReturn,
      rawReturn: opts.excessReturn,
      observedAt: "2026-07-16T00:00:00.000Z",
    }),
  )
}

export function writeRepoPolicy(repoRoot: string): string {
  const path = join(repoRoot, "agent/skills/decision-policy/policy.json")
  mkdirSync(join(repoRoot, "agent/skills/decision-policy"), { recursive: true })
  writeFileSync(path, `${JSON.stringify({
    schema: 1,
    policyVersion: "baseline",
    kind: "baseline",
    createdAt: "2026-07-16T00:00:00.000Z",
    weights: { confidence: 1 },
    thresholds: { track: 0.5, ignore: 0, drop: -0.5 },
    rules: [],
    allowlistPaths: ["agent/skills/decision-policy/policy.json"],
  }, null, 2)}\n`)
  return path
}

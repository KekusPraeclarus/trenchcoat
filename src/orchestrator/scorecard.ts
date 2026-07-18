import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { writeJsonRecord, type ArchiveLayout } from "../lib/archive.js"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { sha256Json } from "../lib/canonical-json.js"
import {
  DecisionBundleSchema,
  OutcomeObservationSchema,
  ScorecardSchema,
  type DecisionBundle,
  type OutcomeObservation,
  type Scorecard,
} from "../contracts/schemas.js"
import {
  freezeAuditEpoch,
  type AuditEpochManifest,
  type AuditEpochInput,
} from "./audit.js"
import {
  applyFeeBps,
  brierScore,
  excessReturn,
  wilsonLowerBound,
} from "./audit-math.js"

export type EpochStatus = "building" | "sealed"

export type EpochStatusFile = Readonly<{
  schema: 1
  epochId: string
  status: EpochStatus
  manifestHash: `sha256:${string}`
  scorecardHash?: `sha256:${string}`
  sealedAt?: string
}>

export function epochDir(layout: ArchiveLayout, epochId: string): string {
  return join(layout.epochs, epochId)
}

export function writeDecisionBundle(
  layout: ArchiveLayout,
  bundle: DecisionBundle,
): Promise<`sha256:${string}`> {
  const parsed = DecisionBundleSchema.parse(bundle)
  return writeJsonRecord(join(layout.decisions, `${parsed.decisionId}.json`), parsed as never)
}

export function writeOutcomeObservation(
  layout: ArchiveLayout,
  observation: OutcomeObservation,
): Promise<`sha256:${string}`> {
  const parsed = OutcomeObservationSchema.parse(observation)
  const dir = join(
    layout.outcomes,
    parsed.subjectType,
    parsed.subjectId,
  )
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return writeJsonRecord(
    join(dir, `${parsed.horizonHours}h.json`),
    parsed as never,
  )
}

export function readOutcomeObservation(
  layout: ArchiveLayout,
  subjectType: OutcomeObservation["subjectType"],
  subjectId: string,
  horizonHours: number,
): OutcomeObservation | undefined {
  const path = join(layout.outcomes, subjectType, subjectId, `${horizonHours}h.json`)
  if (!existsSync(path)) return undefined
  return OutcomeObservationSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

export function planAuditEpoch(input: AuditEpochInput): AuditEpochManifest {
  return freezeAuditEpoch(input)
}

export async function beginEpochBuild(
  layout: ArchiveLayout,
  manifest: AuditEpochManifest,
): Promise<void> {
  const dir = epochDir(layout, manifest.epochId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const building = join(dir, "building")
  mkdirSync(building, { recursive: true, mode: 0o700 })
  await writeJsonRecord(join(building, "manifest.json"), manifest as never)
  const status: EpochStatusFile = {
    schema: 1,
    epochId: manifest.epochId,
    status: "building",
    manifestHash: manifest.manifestHash,
  }
  await writeJsonRecord(join(building, "status.json"), status as never)
}

export async function sealEpoch(
  layout: ArchiveLayout,
  epochId: string,
  scorecard: Scorecard,
  sealedAt: string,
): Promise<EpochStatusFile> {
  const dir = epochDir(layout, epochId)
  const building = join(dir, "building")
  if (!existsSync(join(building, "manifest.json"))) {
    throw new Error(`No building epoch ${epochId}`)
  }
  const manifest = JSON.parse(
    readFileSync(join(building, "manifest.json"), "utf8"),
  ) as AuditEpochManifest
  const parsed = ScorecardSchema.parse(scorecard)
  if (parsed.epochId !== epochId) {
    throw new Error("Scorecard epochId mismatch")
  }
  const scorecardHash = await writeJsonRecord(
    join(building, "scorecard.json"),
    parsed as never,
  )
  const status: EpochStatusFile = {
    schema: 1,
    epochId,
    status: "sealed",
    manifestHash: manifest.manifestHash,
    scorecardHash,
    sealedAt,
  }
  await writeJsonRecord(join(building, "status.json"), status as never)

  // Atomic publish: rename building → sealed only after all artifacts present
  const sealed = join(dir, "sealed")
  if (existsSync(sealed)) {
    const existing = JSON.parse(
      readFileSync(join(sealed, "status.json"), "utf8"),
    ) as EpochStatusFile
    if (existing.manifestHash !== status.manifestHash) {
      throw new Error(`Sealed epoch ${epochId} hash conflict`)
    }
    return existing
  }
  renameSync(building, sealed)
  return status
}

export function loadSealedEpoch(
  layout: ArchiveLayout,
  epochId: string,
): Readonly<{ manifest: AuditEpochManifest, scorecard: Scorecard, status: EpochStatusFile }> {
  const sealed = join(epochDir(layout, epochId), "sealed")
  if (!existsSync(sealed)) throw new Error(`Epoch ${epochId} is not sealed`)
  const status = JSON.parse(readFileSync(join(sealed, "status.json"), "utf8")) as EpochStatusFile
  if (status.status !== "sealed") throw new Error(`Epoch ${epochId} status is ${status.status}`)
  const manifest = JSON.parse(
    readFileSync(join(sealed, "manifest.json"), "utf8"),
  ) as AuditEpochManifest
  const scorecard = ScorecardSchema.parse(
    JSON.parse(readFileSync(join(sealed, "scorecard.json"), "utf8")),
  )
  if (manifest.manifestHash !== status.manifestHash) {
    throw new Error("Sealed epoch manifest hash mismatch")
  }
  return { manifest, scorecard, status }
}

export type ScorecardInput = Readonly<{
  epochId: string
  sealedAt: string
  manifestHash: `sha256:${string}`
  decisions: readonly {
    verdict: string
    confidence: number
    hit?: boolean
    excess72h?: number
    dropVindicated?: boolean
    ignoreWasMiss?: boolean
  }[]
  broadcasts: readonly { precise?: boolean }[]
  sourceCalls: readonly { settled: boolean }[]
  outcomes: readonly { status: string }[]
  rugs: readonly { rug: boolean }[]
  paperPnlGross: number
  paperPnlCostAdjusted: number
  costUsd?: number
  failureCount?: number
}>

function rate(
  numerator: number,
  denominator: number,
  exclusions = 0,
  exclusionReasons: string[] = [],
) {
  return { numerator, denominator, exclusions, exclusionReasons }
}

export function computeScorecard(input: ScorecardInput): Scorecard {
  const tracks = input.decisions.filter((d) => d.verdict === "track" && d.hit !== undefined)
  const hits = tracks.filter((d) => d.hit)
  const drops = input.decisions.filter((d) => d.verdict === "drop" && d.dropVindicated !== undefined)
  const dropHits = drops.filter((d) => d.dropVindicated)
  const ignores = input.decisions.filter((d) => d.verdict === "ignore" && d.ignoreWasMiss !== undefined)
  const ignoreMisses = ignores.filter((d) => d.ignoreWasMiss)
  const excess = input.decisions
    .filter((d) => d.excess72h !== undefined)
    .map((d) => d.excess72h!)
  const broadcasts = input.broadcasts.filter((b) => b.precise !== undefined)
  const broadcastHits = broadcasts.filter((b) => b.precise)
  const settledSources = input.sourceCalls.filter((s) => s.settled)
  const completeOutcomes = input.outcomes.filter((o) => o.status === "complete")
  const rugs = input.rugs.filter((r) => r.rug)

  const forecasts = tracks.map((d) => d.confidence / 100)
  const outcomes = tracks.map((d) => (d.hit ? 1 : 0))

  return ScorecardSchema.parse({
    schema: 1,
    epochId: input.epochId,
    sealedAt: input.sealedAt,
    manifestHash: input.manifestHash,
    paperPnlGross: input.paperPnlGross,
    paperPnlCostAdjusted: input.paperPnlCostAdjusted,
    cohortExcess72h: rate(
      excess.reduce((a, b) => a + b, 0),
      Math.max(1, excess.length),
    ),
    hitRate: rate(hits.length, tracks.length),
    dropPrecision: rate(dropHits.length, drops.length),
    ignoreMissRate: rate(ignoreMisses.length, ignores.length),
    ...(forecasts.length > 0
      ? { calibrationBrier: brierScore(forecasts, outcomes) }
      : {}),
    broadcastPrecision: rate(broadcastHits.length, broadcasts.length),
    sourceCallCoverage: rate(settledSources.length, input.sourceCalls.length),
    outcomeCoverage: rate(completeOutcomes.length, input.outcomes.length),
    rugExposure: rate(rugs.length, Math.max(1, input.rugs.length)),
    costUsd: input.costUsd ?? 0,
    failureCount: input.failureCount ?? 0,
  })
}

export function materializeSyntheticOutcome(args: Readonly<{
  subjectId: string
  subjectType: OutcomeObservation["subjectType"]
  horizonHours: number
  eventTs: string
  entryPrice: number
  exitPrice: number
  benchmarkReturn: number
  feeBpsPerSide: number
  observedAt: string
  rug?: boolean
}>): OutcomeObservation {
  const raw = (args.exitPrice / args.entryPrice) - 1
  const costAdjusted = applyFeeBps(raw, args.feeBpsPerSide)
  const excess = excessReturn(costAdjusted, args.benchmarkReturn)
  return OutcomeObservationSchema.parse({
    schema: 1,
    subjectType: args.subjectType,
    subjectId: args.subjectId,
    horizonHours: args.horizonHours,
    observationSpecVersion: 1,
    status: args.rug ? "terminal-loss" : "complete",
    eventTs: args.eventTs,
    targetPrice: args.exitPrice,
    benchmarkReturn: args.benchmarkReturn,
    excessReturn: args.rug ? -1 : excess,
    rawReturn: args.rug ? -1 : raw,
    observedAt: args.observedAt,
  })
}

export function wilsonHitLb(hits: number, total: number): number {
  return wilsonLowerBound(hits, total)
}

export async function persistScorecardToState(
  agentRoot: string,
  scorecard: Scorecard,
): Promise<void> {
  const path = join(agentRoot, "state", "scorecard.json")
  mkdirSync(join(agentRoot, "state"), { recursive: true, mode: 0o700 })
  await writeAtomicFile(path, `${JSON.stringify(scorecard, null, 2)}\n`)
}

export function verifySealedRerun(
  left: AuditEpochManifest,
  right: AuditEpochManifest,
): void {
  if (left.manifestHash !== right.manifestHash) {
    throw new Error("Sealed rerun is not byte-identical")
  }
  if (sha256Json(left as never) !== sha256Json(right as never)) {
    throw new Error("Sealed rerun payload mismatch")
  }
}

/** Append-only JSONL for host attribution logs */
export async function appendJsonl(
  path: string,
  record: unknown,
): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const line = `${JSON.stringify(record)}\n`
  if (!existsSync(path)) {
    writeFileSync(path, line, { mode: 0o600 })
    return
  }
  const fd = openSync(path, "a", 0o600)
  try {
    appendFileSync(fd, line)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

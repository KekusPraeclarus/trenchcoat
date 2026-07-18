import { type ArchiveLayout } from "../lib/archive.js"
import { type Scorecard } from "../contracts/schemas.js"
import { type AuditEpochInput, type AuditEpochManifest } from "./audit.js"
import {
  planAuditEpoch,
  beginEpochBuild,
  computeScorecard,
  sealEpoch,
  type ScorecardInput,
  type EpochStatusFile,
} from "./scorecard.js"
import {
  runOutcomesSettle,
  type OutcomesSettleReport,
} from "./outcomes-settle.js"
import {
  type BarProvider,
  type BenchmarkProvider,
} from "./observations.js"
import { type SourceCallEvent, type WalletBuyOutcome } from "../contracts/schemas.js"

/** Scorecard cohort minus fields the epoch manifest owns */
export type ScorecardCohort = Omit<ScorecardInput, "epochId" | "sealedAt" | "manifestHash">

export type AuditEpochResult = Readonly<{
  manifest: AuditEpochManifest
  settle: OutcomesSettleReport
  scorecard: Scorecard
  status: EpochStatusFile
}>

/**
 * Plan -> settle -> scorecard -> seal, composed from the existing audit and scorecard
 * modules. This is a callable API only: it registers no job and owns no scheduling, so the
 * orchestrator or a test can drive one reproducible epoch. Re-running a sealed epoch id is a
 * byte-identical verification via sealEpoch.
 */
export async function runAuditEpoch(args: Readonly<{
  layout: ArchiveLayout
  epochInput: AuditEpochInput
  sealedAt: string
  cohort: ScorecardCohort
  settle?: Readonly<{
    nowIso: string
    horizons?: readonly number[]
    settlementHours?: number
    sourceBars?: BarProvider<SourceCallEvent>
    sourceBenchmark?: BenchmarkProvider<SourceCallEvent>
    walletBars?: BarProvider<WalletBuyOutcome>
    walletBenchmark?: BenchmarkProvider<WalletBuyOutcome>
    feeBpsPerSide?: number
  }>
}>): Promise<AuditEpochResult> {
  const manifest = planAuditEpoch(args.epochInput)
  await beginEpochBuild(args.layout, manifest)

  const settle = await runOutcomesSettle({
    layout: args.layout,
    nowIso: args.settle?.nowIso ?? args.sealedAt,
    ...(args.settle?.horizons ? { horizons: args.settle.horizons } : {}),
    ...(args.settle?.settlementHours !== undefined ? { settlementHours: args.settle.settlementHours } : {}),
    ...(args.settle?.sourceBars ? { sourceBars: args.settle.sourceBars } : {}),
    ...(args.settle?.sourceBenchmark ? { sourceBenchmark: args.settle.sourceBenchmark } : {}),
    ...(args.settle?.walletBars ? { walletBars: args.settle.walletBars } : {}),
    ...(args.settle?.walletBenchmark ? { walletBenchmark: args.settle.walletBenchmark } : {}),
    ...(args.settle?.feeBpsPerSide !== undefined ? { feeBpsPerSide: args.settle.feeBpsPerSide } : {}),
  })

  const scorecard = computeScorecard({
    ...args.cohort,
    epochId: manifest.epochId,
    sealedAt: args.sealedAt,
    manifestHash: manifest.manifestHash,
  })

  const status = await sealEpoch(args.layout, manifest.epochId, scorecard, args.sealedAt)
  return { manifest, settle, scorecard, status }
}

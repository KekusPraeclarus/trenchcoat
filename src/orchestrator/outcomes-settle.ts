import { type ArchiveLayout } from "../lib/archive.js"
import { type SourceCallEvent, type WalletBuyOutcome } from "../contracts/schemas.js"
import { type BarProvider, type BenchmarkProvider } from "./observations.js"
import {
  runSettleSourceCalls,
  DEFAULT_HORIZONS,
  DEFAULT_SETTLEMENT_HOURS,
  type SourceSettleReport,
} from "./settle-source-calls.js"
import { runSettleWalletBuys, type WalletSettleReport } from "./settle-wallet-buys.js"

export type OutcomesSettleReport = Readonly<{
  sourceCalls: SourceSettleReport
  walletBuys: WalletSettleReport
}>

/**
 * Journal-friendly driver: settle every mature source call and wallet buy into immutable
 * outcome observations. Pure over its inputs and injected pricing, registers no job, and is
 * safe to re-run (both settlers skip already-complete observations).
 */
export async function runOutcomesSettle(args: Readonly<{
  layout: ArchiveLayout
  nowIso: string
  horizons?: readonly number[]
  settlementHours?: number
  sourceBars?: BarProvider<SourceCallEvent>
  sourceBenchmark?: BenchmarkProvider<SourceCallEvent>
  walletBars?: BarProvider<WalletBuyOutcome>
  walletBenchmark?: BenchmarkProvider<WalletBuyOutcome>
  feeBpsPerSide?: number
}>): Promise<OutcomesSettleReport> {
  const horizons = args.horizons ?? DEFAULT_HORIZONS
  const settlementHours = args.settlementHours ?? DEFAULT_SETTLEMENT_HOURS

  const sourceCalls = await runSettleSourceCalls({
    layout: args.layout,
    nowIso: args.nowIso,
    horizons,
    settlementHours,
    ...(args.sourceBars ? { loadBars: args.sourceBars } : {}),
    ...(args.sourceBenchmark ? { benchmark: args.sourceBenchmark } : {}),
    ...(args.feeBpsPerSide !== undefined ? { feeBpsPerSide: args.feeBpsPerSide } : {}),
  })

  const walletBuys = await runSettleWalletBuys({
    layout: args.layout,
    nowIso: args.nowIso,
    horizons,
    settlementHours,
    ...(args.walletBars ? { loadBars: args.walletBars } : {}),
    ...(args.walletBenchmark ? { benchmark: args.walletBenchmark } : {}),
    ...(args.feeBpsPerSide !== undefined ? { feeBpsPerSide: args.feeBpsPerSide } : {}),
  })

  return { sourceCalls, walletBuys }
}

import { type ArchiveLayout } from "../lib/archive.js"
import {
  type CanonicalIdentity,
  type SourceCallEvent,
  type WalletBuyOutcome,
} from "../contracts/schemas.js"
import { type BarProvider, type BenchmarkProvider } from "./observations.js"
import {
  runSettleSourceCalls,
  DEFAULT_HORIZONS,
  DEFAULT_SETTLEMENT_HOURS,
  type SourceSettleReport,
} from "./settle-source-calls.js"
import { runSettleSourcePeaks, type SourcePeakSettleReport } from "./settle-source-peaks.js"
import { runSettleWalletBuys, type WalletSettleReport } from "./settle-wallet-buys.js"
import {
  runSettleWalletCopyTrades,
  type WalletCopyTradeSettleReport,
} from "./settle-wallet-copy-trades.js"
import {
  runSettleFomoCopyTrades,
  type FomoCopyTradeSettleReport,
} from "./settle-fomo-copy-trades.js"
import {
  runSettlePumpCalls,
  type PumpCallSettleReport,
} from "./settle-pump-calls.js"
import { runLedgerSettle, type LedgerSettleReport } from "./settle-ledger.js"

export type OutcomesSettleReport = Readonly<{
  sourceCalls: SourceSettleReport
  sourcePeaks: SourcePeakSettleReport
  walletBuys: WalletSettleReport
  walletCopyTrades: WalletCopyTradeSettleReport
  fomoCopyTrades: FomoCopyTradeSettleReport
  pumpCalls: PumpCallSettleReport
  ledger?: LedgerSettleReport
}>

/**
 * Journal-friendly driver: horizon diagnostics, peak shill settlement, wallet
 * copy-trade + Fomo feed copy-trade, then paper ledger entry finalisation.
 * Archive settlers are lock-free; ledger RMW uses a brief agent lock when agentRoot is set.
 */
export async function runOutcomesSettle(args: Readonly<{
  layout: ArchiveLayout
  nowIso: string
  agentRoot?: string
  horizons?: readonly number[]
  settlementHours?: number
  sourceBars?: BarProvider<SourceCallEvent>
  sourceBenchmark?: BenchmarkProvider<SourceCallEvent>
  walletBars?: BarProvider<WalletBuyOutcome>
  walletBenchmark?: BenchmarkProvider<WalletBuyOutcome>
  identityBars?: BarProvider<CanonicalIdentity>
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

  const sourcePeaks = await runSettleSourcePeaks({
    layout: args.layout,
    nowIso: args.nowIso,
    ...(args.sourceBars ? { loadBars: args.sourceBars } : {}),
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

  const walletCopyTrades = await runSettleWalletCopyTrades({
    layout: args.layout,
    nowIso: args.nowIso,
    ...(args.walletBars ? { loadBars: args.walletBars } : {}),
    ...(args.feeBpsPerSide !== undefined ? { feeBpsPerSide: args.feeBpsPerSide } : {}),
  })

  const fomoCopyTrades = await runSettleFomoCopyTrades({
    layout: args.layout,
    nowIso: args.nowIso,
    ...(args.agentRoot ? { agentRoot: args.agentRoot } : {}),
    ...(args.walletBars
      ? {
          loadBars: async (
            token: Readonly<{ chain: string; tokenAddress: string }>,
            horizonHours: number,
          ) => {
            const synthetic: WalletBuyOutcome = {
              schema: 1,
              eventId: "fomo_bar",
              walletId: `fomo:${token.tokenAddress}`,
              chain: token.chain as WalletBuyOutcome["chain"],
              tokenAddress: token.tokenAddress,
              boughtAt: args.nowIso,
              finalized: true,
              removed: false,
              priceable: true,
              rug: false,
              side: "buy",
            }
            return args.walletBars!(synthetic, horizonHours)
          },
        }
      : {}),
    ...(args.feeBpsPerSide !== undefined ? { feeBpsPerSide: args.feeBpsPerSide } : {}),
  })

  const pumpCalls = await runSettlePumpCalls({
    layout: args.layout,
    nowIso: args.nowIso,
    ...(args.agentRoot ? { agentRoot: args.agentRoot } : {}),
    ...(args.walletBars
      ? {
          loadBars: async (event, horizonHours) => {
            const synthetic: WalletBuyOutcome = {
              schema: 1,
              eventId: "pump_bar",
              walletId: `pump:${event.tokenAddress}`,
              chain: event.chain as WalletBuyOutcome["chain"],
              tokenAddress: event.tokenAddress,
              boughtAt: args.nowIso,
              finalized: true,
              removed: false,
              priceable: true,
              rug: false,
              side: "buy",
            }
            return args.walletBars!(synthetic, horizonHours)
          },
        }
      : {}),
  })

  let ledger: LedgerSettleReport | undefined
  if (args.agentRoot) {
    ledger = await runLedgerSettle({
      agentRoot: args.agentRoot,
      layout: args.layout,
      nowIso: args.nowIso,
      ...(args.identityBars ? { loadBars: args.identityBars } : {}),
    })
  }

  return {
    sourceCalls,
    sourcePeaks,
    walletBuys,
    walletCopyTrades,
    fomoCopyTrades,
    pumpCalls,
    ...(ledger ? { ledger } : {}),
  }
}

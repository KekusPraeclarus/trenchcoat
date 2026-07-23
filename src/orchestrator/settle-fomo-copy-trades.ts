import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeJsonRecord, type ArchiveLayout } from "../lib/archive.js"
import { withAgentWorkspaceLock } from "../lib/lock.js"
import { StateStore } from "../lib/state.js"
import {
  FomoTradeOutcomeSchema,
  FomoTraderScoresFileSchema,
  type FomoTradeOutcome,
  type FomoTraderScore,
  type FomoTraderScoresFile,
} from "../contracts/schemas.js"
import { barPricedReturn, matchFifoCloses } from "./copy-trade-fifo.js"
import type { PriceBar } from "./observations.js"

type Batch = Readonly<{ name: string; body: Record<string, unknown>; outcomes: FomoTradeOutcome[] }>

function loadBatches(layout: ArchiveLayout): Batch[] {
  const dir = layout.outcomes
  if (!existsSync(dir)) return []
  const batches: Batch[] = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.startsWith("fomo-trade-") || !name.endsWith(".json")) continue
    const body = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>
    const outcomes: FomoTradeOutcome[] = []
    for (const entry of (body["outcomes"] as unknown[]) ?? []) {
      const parsed = FomoTradeOutcomeSchema.safeParse(entry)
      if (parsed.success) outcomes.push(parsed.data)
    }
    batches.push({ name, body, outcomes })
  }
  return batches
}

function lotKey(o: FomoTradeOutcome): string {
  return `${o.handle.toLowerCase()}|${o.chain}|${o.tokenAddress.toLowerCase()}`
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]!
  return (sorted[mid - 1]! + sorted[mid]!) / 2
}

function scoresFromSettled(
  trades: readonly FomoTradeOutcome[],
  scoreCutoff: string,
  nowIso: string,
): FomoTraderScore[] {
  const cutoffMs = Date.parse(scoreCutoff)
  const byHandle = new Map<string, number[]>()
  for (const t of trades) {
    if (t.realizedReturn === undefined || !t.settledAt) continue
    if (Date.parse(t.settledAt) > cutoffMs) continue
    if (t.side !== "sell" && t.side !== "buy") continue
    // Prefer buy-side sealed returns; sell stamps are duplicates of the same close
    if (t.side === "sell" && t.linkedBuyEventId) continue
    const list = byHandle.get(t.handle.toLowerCase()) ?? []
    list.push(t.realizedReturn)
    byHandle.set(t.handle.toLowerCase(), list)
  }
  const out: FomoTraderScore[] = []
  for (const [handle, rets] of byHandle) {
    const hits = rets.filter((r) => r >= 0.20).length
    out.push({
      handle,
      settledTrades: rets.length,
      hits,
      hitMean: rets.length === 0 ? 0 : hits / rets.length,
      medianRealized: median(rets),
      scoreCutoff,
      updatedAt: nowIso,
    })
  }
  return out.sort((a, b) => a.handle.localeCompare(b.handle))
}

export type FomoCopyTradeSettleReport = Readonly<{
  scanned: number
  closed: number
  priced: number
  pendingBars: number
  batchesUpdated: number
  tradersScored: number
}>

export type FomoBarProvider = (
  token: Readonly<{ chain: string; tokenAddress: string }>,
  horizonHours: number,
) => Promise<readonly PriceBar[] | undefined> | readonly PriceBar[] | undefined

/**
 * FIFO copy-trade settle for Fomo feed trades (handle+token). Never writes wallets.json.
 */
export async function runSettleFomoCopyTrades(args: Readonly<{
  layout: ArchiveLayout
  nowIso: string
  agentRoot?: string
  loadBars?: FomoBarProvider
  feeBpsPerSide?: number
  scoreCutoffHours?: number
}>): Promise<FomoCopyTradeSettleReport> {
  const batches = loadBatches(args.layout)
  const byEvent = new Map<string, { batchIdx: number; outcome: FomoTradeOutcome }>()
  const groups = new Map<string, FomoTradeOutcome[]>()

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx += 1) {
    for (const outcome of batches[batchIdx]!.outcomes) {
      byEvent.set(outcome.eventId, { batchIdx, outcome })
      const key = lotKey(outcome)
      const list = groups.get(key) ?? []
      list.push(outcome)
      groups.set(key, list)
    }
  }

  const report = {
    scanned: 0,
    closed: 0,
    priced: 0,
    pendingBars: 0,
    batchesUpdated: 0,
    tradersScored: 0,
  }

  const updates = new Map<string, FomoTradeOutcome>()
  const barCache = new Map<string, readonly PriceBar[]>()

  for (const [, trades] of groups) {
    report.scanned += trades.length
    const legs = trades.map((t) => ({
      eventId: t.eventId,
      side: t.side,
      tradedAt: t.tradedAt,
    }))

    const sample = trades[0]!
    const cacheKey = `${sample.chain}|${sample.tokenAddress.toLowerCase()}`
    let bars = barCache.get(cacheKey)
    if (!bars) {
      bars = (await Promise.resolve(
        args.loadBars?.({ chain: sample.chain, tokenAddress: sample.tokenAddress }, 336),
      )) ?? []
      barCache.set(cacheKey, bars)
    }

    const closes = matchFifoCloses(legs, (buyAt, sellAt) => (
      barPricedReturn(bars ?? [], buyAt, sellAt, args.feeBpsPerSide)
    ))

    const buyAgg = new Map<string, { weighted: number; weight: number; hold: number }>()
    for (const close of closes) {
      report.closed += 1
      report.priced += 1
      const weight = Number(BigInt(close.amountRaw))
      const prev = buyAgg.get(close.buyEventId) ?? { weighted: 0, weight: 0, hold: 0 }
      buyAgg.set(close.buyEventId, {
        weighted: prev.weighted + close.realizedReturn * weight,
        weight: prev.weight + weight,
        hold: close.holdHours,
      })

      const sellRef = byEvent.get(close.sellEventId)
      if (sellRef && sellRef.outcome.realizedReturn === undefined) {
        updates.set(close.sellEventId, {
          ...sellRef.outcome,
          settledAt: args.nowIso,
          realizedReturn: close.realizedReturn,
          linkedBuyEventId: close.buyEventId,
          holdHours: close.holdHours,
        })
      }
    }

    for (const [buyId, agg] of buyAgg) {
      const buyRef = byEvent.get(buyId)
      if (!buyRef || buyRef.outcome.realizedReturn !== undefined) continue
      updates.set(buyId, {
        ...buyRef.outcome,
        settledAt: args.nowIso,
        realizedReturn: agg.weight > 0 ? agg.weighted / agg.weight : 0,
        holdHours: agg.hold,
      })
    }

    for (const t of trades) {
      if (t.side !== "sell") continue
      if (t.realizedReturn !== undefined || updates.has(t.eventId)) continue
      report.pendingBars += 1
    }
  }

  if (updates.size > 0) {
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx += 1) {
      const batch = batches[batchIdx]!
      let changed = false
      const next = batch.outcomes.map((o) => {
        const u = updates.get(o.eventId)
        if (!u) return o
        changed = true
        return u
      })
      if (!changed) continue
      await writeJsonRecord(
        join(args.layout.outcomes, batch.name),
        { ...batch.body, outcomes: next } as never,
      )
      report.batchesUpdated += 1
    }
  }

  const allTrades = batches.flatMap((b) => (
    b.outcomes.map((o) => updates.get(o.eventId) ?? o)
  ))
  const cutoffHours = args.scoreCutoffHours ?? 24
  const scoreCutoff = new Date(Date.parse(args.nowIso) - cutoffHours * 3_600_000).toISOString()
  const traders = scoresFromSettled(allTrades, scoreCutoff, args.nowIso)
  report.tradersScored = traders.length

  if (args.agentRoot && traders.length > 0) {
    const file: FomoTraderScoresFile = FomoTraderScoresFileSchema.parse({
      schema: 1,
      traders,
    })
    await withAgentWorkspaceLock(args.agentRoot, async () => {
      const store = new StateStore(join(args.agentRoot!, "state"))
      await store.saveFomoTraderScores(file)
    })
  }

  return report
}

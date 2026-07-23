import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeJsonRecord, type ArchiveLayout } from "../lib/archive.js"
import {
  WalletBuyOutcomeSchema,
  type WalletBuyOutcome,
} from "../contracts/schemas.js"
import { barPricedReturn, matchFifoCloses } from "./copy-trade-fifo.js"
import type { BarProvider } from "./observations.js"

type Batch = Readonly<{ name: string; body: Record<string, unknown>; outcomes: WalletBuyOutcome[] }>

function loadBatches(layout: ArchiveLayout): Batch[] {
  const dir = layout.outcomes
  if (!existsSync(dir)) return []
  const batches: Batch[] = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.startsWith("wallet-buy-") || !name.endsWith(".json")) continue
    const body = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>
    const outcomes: WalletBuyOutcome[] = []
    for (const entry of (body["outcomes"] as unknown[]) ?? []) {
      const parsed = WalletBuyOutcomeSchema.safeParse(entry)
      if (parsed.success) outcomes.push(parsed.data)
    }
    batches.push({ name, body, outcomes })
  }
  return batches
}

function isBuy(o: WalletBuyOutcome): boolean {
  return (o.side ?? "buy") === "buy"
}

function lotKey(o: WalletBuyOutcome): string {
  return `${o.walletId}|${o.chain}|${o.tokenAddress.toLowerCase()}`
}

export type WalletCopyTradeSettleReport = Readonly<{
  scanned: number
  closed: number
  priced: number
  pendingBars: number
  batchesUpdated: number
}>

/**
 * FIFO buy→sell copy-trade settlement. Open buys without a sell stay unsettled
 * (no invented horizon P&L). Realized return stamps onto both buy and sell rows.
 */
export async function runSettleWalletCopyTrades(args: Readonly<{
  layout: ArchiveLayout
  nowIso: string
  loadBars?: BarProvider<WalletBuyOutcome>
  feeBpsPerSide?: number
}>): Promise<WalletCopyTradeSettleReport> {
  const batches = loadBatches(args.layout)
  const byEvent = new Map<string, { batchIdx: number; outcome: WalletBuyOutcome }>()
  const groups = new Map<string, WalletBuyOutcome[]>()

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx += 1) {
    for (const outcome of batches[batchIdx]!.outcomes) {
      if (!outcome.finalized || outcome.removed || !outcome.priceable) continue
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
  }

  const updates = new Map<string, WalletBuyOutcome>()
  const barCache = new Map<string, Awaited<ReturnType<NonNullable<typeof args.loadBars>>>>()

  for (const [, trades] of groups) {
    report.scanned += trades.length
    const already = trades.some((t) => (
      !isBuy(t) && t.realizedReturn !== undefined && t.settledAt !== undefined
    ))
    // Re-run matching so partial progress resumes; skip fully settled sell rows when updating
    const legs = trades.map((t) => ({
      eventId: t.eventId,
      side: (isBuy(t) ? "buy" : "sell") as "buy" | "sell",
      tradedAt: t.boughtAt,
      ...(t.tokenAmountRaw ? { amountRaw: t.tokenAmountRaw } : {}),
    }))

    const sample = trades[0]!
    const cacheKey = `${sample.chain}|${sample.tokenAddress.toLowerCase()}`
    let bars = barCache.get(cacheKey)
    if (bars === undefined) {
      bars = (await Promise.resolve(args.loadBars?.(sample, 336))) ?? []
      barCache.set(cacheKey, bars)
    }

    const closes = matchFifoCloses(legs, (buyAt, sellAt) => (
      barPricedReturn(bars ?? [], buyAt, sellAt, args.feeBpsPerSide)
    ))

    if (closes.length === 0 && !already) continue

    // Aggregate realized per buy (VWAP of closed slices) and stamp sells
    const buyAgg = new Map<string, { weighted: number; weight: number; lastSell: string; hold: number }>()
    for (const close of closes) {
      report.closed += 1
      report.priced += 1
      const weight = Number(BigInt(close.amountRaw))
      const prev = buyAgg.get(close.buyEventId) ?? { weighted: 0, weight: 0, lastSell: close.soldAt, hold: 0 }
      buyAgg.set(close.buyEventId, {
        weighted: prev.weighted + close.realizedReturn * weight,
        weight: prev.weight + weight,
        lastSell: close.soldAt,
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
      // Only seal buy when fully consumed across closes matching remaining
      const buyLeg = legs.find((l) => l.eventId === buyId)
      const buyAmt = buyLeg?.amountRaw ? BigInt(buyLeg.amountRaw) : 1n
      let closedAmt = 0n
      for (const c of closes) {
        if (c.buyEventId === buyId) closedAmt += BigInt(c.amountRaw)
      }
      if (closedAmt < buyAmt) continue
      updates.set(buyId, {
        ...buyRef.outcome,
        settledAt: args.nowIso,
        realizedReturn: agg.weight > 0 ? agg.weighted / agg.weight : 0,
        holdHours: agg.hold,
      })
    }

    // Count sells that could not price
    for (const t of trades) {
      if (isBuy(t)) continue
      if (t.realizedReturn !== undefined) continue
      if (!updates.has(t.eventId)) report.pendingBars += 1
    }
  }

  if (updates.size === 0) return report

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

  return report
}

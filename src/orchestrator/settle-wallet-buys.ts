import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeJsonRecord, type ArchiveLayout } from "../lib/archive.js"
import {
  OutcomeObservationSchema,
  WalletBuyOutcomeSchema,
  type OutcomeObservation,
  type WalletBuyOutcome,
} from "../contracts/schemas.js"
import { writeOutcomeObservation, readOutcomeObservation } from "./scorecard.js"
import {
  materializeObservation,
  type BarProvider,
  type BenchmarkProvider,
} from "./observations.js"
import { DEFAULT_HORIZONS, DEFAULT_SETTLEMENT_HOURS } from "./settle-source-calls.js"

const HOUR_MS = 3_600_000
const HEADLINE_HORIZON = 72

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

function isMature(boughtAt: string, horizonHours: number, settlementHours: number, nowMs: number): boolean {
  return Date.parse(boughtAt) + (horizonHours + settlementHours) * HOUR_MS <= nowMs
}

/** censored/pending record for an invalidated or not-yet-final buy, never a fabricated loss */
function nonPriced(
  outcome: WalletBuyOutcome,
  horizonHours: number,
  status: "provider-pending" | "censored",
  reason: string,
  observedAt: string,
): OutcomeObservation {
  return OutcomeObservationSchema.parse({
    schema: 1,
    subjectType: "wallet-buy",
    subjectId: outcome.eventId,
    horizonHours,
    observationSpecVersion: 1,
    status,
    eventTs: outcome.boughtAt,
    exclusionReason: reason,
    observedAt,
  })
}

export type WalletSettleReport = Readonly<{
  scanned: number
  written: number
  complete: number
  pending: number
  censored: number
  skipped: number
  buysUpdated: number
}>

/**
 * Price wallet-buy events at each horizon into unified wallet-buy outcome observations,
 * and reflect the settled 72h result back into the WalletBuyOutcome batch for lifecycle
 * consumers. Removed/reorged buys are censored, unfinalized ones pending; missing data is
 * never converted into a loss (INV-S18/S19). Resumable: complete observations are skipped
 * and batch files are only rewritten when a settled field actually changes.
 */
export async function runSettleWalletBuys(args: Readonly<{
  layout: ArchiveLayout
  nowIso: string
  horizons?: readonly number[]
  settlementHours?: number
  loadBars?: BarProvider<WalletBuyOutcome>
  benchmark?: BenchmarkProvider<WalletBuyOutcome>
  feeBpsPerSide?: number
}>): Promise<WalletSettleReport> {
  const horizons = args.horizons ?? DEFAULT_HORIZONS
  const settlementHours = args.settlementHours ?? DEFAULT_SETTLEMENT_HOURS
  const nowMs = Date.parse(args.nowIso)
  if (!Number.isFinite(nowMs)) throw new TypeError("Invalid nowIso")

  const report = {
    scanned: 0,
    written: 0,
    complete: 0,
    pending: 0,
    censored: 0,
    skipped: 0,
    buysUpdated: 0,
  }

  for (const batch of loadBatches(args.layout)) {
    let batchChanged = false
    const updated = new Map<string, WalletBuyOutcome>()

    for (const outcome of batch.outcomes) {
      let headline: OutcomeObservation | undefined
      for (const horizonHours of horizons) {
        if (!isMature(outcome.boughtAt, horizonHours, settlementHours, nowMs)) continue
        report.scanned += 1

        const existing = readOutcomeObservation(args.layout, "wallet-buy", outcome.eventId, horizonHours)
        if (existing && (existing.status === "complete" || existing.status === "terminal-loss")) {
          report.skipped += 1
          if (horizonHours === HEADLINE_HORIZON) headline = existing
          continue
        }

        const observation = await observeBuy(outcome, horizonHours, args)
        await writeOutcomeObservation(args.layout, observation)
        report.written += 1
        if (observation.status === "complete") report.complete += 1
        else if (observation.status === "provider-pending") report.pending += 1
        else report.censored += 1
        if (horizonHours === HEADLINE_HORIZON) headline = observation
      }

      const merged = mergeSettled(outcome, headline, args.nowIso)
      if (merged) {
        updated.set(outcome.eventId, merged)
        batchChanged = true
        report.buysUpdated += 1
      }
    }

    if (batchChanged) {
      const nextOutcomes = batch.outcomes.map((o) => updated.get(o.eventId) ?? o)
      await writeJsonRecord(
        join(args.layout.outcomes, batch.name),
        { ...batch.body, outcomes: nextOutcomes } as never,
      )
    }
  }

  return report
}

async function observeBuy(
  outcome: WalletBuyOutcome,
  horizonHours: number,
  args: Readonly<{
    loadBars?: BarProvider<WalletBuyOutcome>
    benchmark?: BenchmarkProvider<WalletBuyOutcome>
    feeBpsPerSide?: number
    nowIso: string
  }>,
): Promise<OutcomeObservation> {
  if (outcome.removed) {
    return nonPriced(outcome, horizonHours, "censored", "removed: reorg invalidated buy", args.nowIso)
  }
  if (!outcome.finalized) {
    return nonPriced(outcome, horizonHours, "provider-pending", "unfinalized: awaiting finality", args.nowIso)
  }
  if (!outcome.priceable) {
    return nonPriced(outcome, horizonHours, "censored", "unpriceable buy", args.nowIso)
  }
  const bars = (await Promise.resolve(args.loadBars?.(outcome, horizonHours))) ?? []
  const benchmark = await Promise.resolve(args.benchmark?.(outcome, horizonHours))
  return materializeObservation({
    subjectType: "wallet-buy",
    subjectId: outcome.eventId,
    eventTs: outcome.boughtAt,
    horizonHours,
    bars,
    observedAt: args.nowIso,
    ...(benchmark !== undefined ? { benchmarkReturn: benchmark } : {}),
    ...(args.feeBpsPerSide !== undefined ? { feeBpsPerSide: args.feeBpsPerSide } : {}),
  })
}

/** returns a new WalletBuyOutcome only when the 72h settled fields change */
function mergeSettled(
  outcome: WalletBuyOutcome,
  headline: OutcomeObservation | undefined,
  nowIso: string,
): WalletBuyOutcome | undefined {
  if (!headline || headline.status !== "complete" || headline.excessReturn === undefined) return undefined
  if (outcome.settledAt !== undefined && outcome.excessReturn72h === headline.excessReturn) return undefined
  return {
    ...outcome,
    settledAt: nowIso,
    excessReturn72h: headline.excessReturn,
  }
}

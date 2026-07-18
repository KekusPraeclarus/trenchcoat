import { sha256Bytes } from "../lib/fs-atomic.js"
import { canonicalJson } from "../lib/canonical-json.js"
import { OutcomeObservationSchema, type OutcomeObservation } from "../contracts/schemas.js"
import { firstEligibleObservation, type Observation } from "./ledger.js"
import { applyFeeBps, excessReturn } from "./audit-math.js"

/** OHLCV-like bar. finalized means the candle is closed and safe to price from */
export type PriceBar = Readonly<{
  ts: string
  open: number
  finalized: boolean
}>

/** Injected pricing: finalized bars for a subject at a horizon (empty/undefined ok) */
export type BarProvider<T> = (
  subject: T,
  horizonHours: number,
) =>
  | Promise<readonly PriceBar[] | undefined>
  | readonly PriceBar[]
  | undefined
export type BenchmarkProvider<T> = (
  subject: T,
  horizonHours: number,
) => Promise<number | undefined> | number | undefined

export type MaterializeInput = Readonly<{
  subjectType: OutcomeObservation["subjectType"]
  subjectId: string
  eventTs: string
  horizonHours: number
  bars: readonly PriceBar[]
  observedAt: string
  benchmarkReturn?: number
  feeBpsPerSide?: number
  observationSpecVersion?: number
}>

const HOUR_MS = 3_600_000

function priceable(bar: PriceBar): boolean {
  return bar.finalized && Number.isFinite(bar.open) && bar.open > 0
}

/** finalized bars as ledger observations so P0 selection matches firstEligibleObservation */
function finalizedObservations(bars: readonly PriceBar[]): Observation[] {
  return bars
    .filter(priceable)
    .map((bar) => ({
      ts: bar.ts,
      open: bar.open,
      hash: sha256Bytes(canonicalJson({ ts: bar.ts, open: bar.open })),
    }))
}

/** earliest finalized eligible bar at or after cutoff (horizon leg) */
function firstAtOrAfter(observations: readonly Observation[], cutoffMs: number): Observation | undefined {
  return observations
    .filter((o) => Date.parse(o.ts) >= cutoffMs)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))[0]
}

/**
 * Build one immutable outcome observation for a subject/horizon from finalized bars.
 * P0 is the first finalized eligible open strictly after eventTs; Ph the first at or
 * after eventTs+horizon. Absent or unfinalized legs never invent a loss: they yield
 * provider-pending (retryable, unfinalized coverage exists) or censored (nothing
 * defensible), so a missing pool can never be scored as -1.
 */
export function materializeObservation(input: MaterializeInput): OutcomeObservation {
  const eventMs = Date.parse(input.eventTs)
  if (!Number.isFinite(eventMs)) throw new TypeError("Invalid eventTs")
  const horizonMs = eventMs + input.horizonHours * HOUR_MS

  const finalized = finalizedObservations(input.bars)
  const p0 = firstEligibleObservation(input.eventTs, finalized)
  const ph = firstAtOrAfter(finalized, horizonMs)

  const base = {
    schema: 1 as const,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    horizonHours: input.horizonHours,
    observationSpecVersion: input.observationSpecVersion ?? 1,
    eventTs: input.eventTs,
    observedAt: input.observedAt,
  }

  if (p0 && ph) {
    const raw = ph.open / p0.open - 1
    const costAdjusted = input.feeBpsPerSide !== undefined
      ? applyFeeBps(raw, input.feeBpsPerSide)
      : raw
    const excess = excessReturn(costAdjusted, input.benchmarkReturn ?? 0)
    return OutcomeObservationSchema.parse({
      ...base,
      status: "complete",
      targetPrice: ph.open,
      rawReturn: raw,
      excessReturn: excess,
      ...(input.benchmarkReturn !== undefined ? { benchmarkReturn: input.benchmarkReturn } : {}),
    })
  }

  const missing: string[] = []
  if (!p0) missing.push("p0")
  if (!ph) missing.push("ph")

  // unfinalized coverage for a missing leg means the price may still finalize later
  const retryable = input.bars.some((bar) => (
    !bar.finalized
    && Number.isFinite(bar.open)
    && bar.open > 0
    && ((!p0 && Date.parse(bar.ts) > eventMs) || (!ph && Date.parse(bar.ts) >= horizonMs))
  ))
  const status = retryable ? "provider-pending" : "censored"

  return OutcomeObservationSchema.parse({
    ...base,
    status,
    exclusionReason: `missing ${missing.join("+")}: ${
      retryable ? "unfinalized bars present, retry pending" : "no eligible finalized bars"
    }`,
  })
}

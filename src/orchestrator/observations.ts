import { sha256Bytes } from "../lib/fs-atomic.js"
import { canonicalJson } from "../lib/canonical-json.js"
import { OutcomeObservationSchema, type OutcomeObservation } from "../contracts/schemas.js"
import { firstEligibleObservation, type Observation } from "./ledger.js"
import { applyFeeBps, excessReturn } from "./audit-math.js"

/** OHLCV-like bar. finalized means the candle is closed and safe to price from */
export type PriceBar = Readonly<{
  ts: string
  open: number
  /** Candle high when available (peak settlement) */
  high?: number
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
export const PEAK_QUIET_HOURS = 6
export const PEAK_MAX_WAIT_DAYS = 14
/** Archive path key for peak settlements (observationSpecVersion 2) */
export const PEAK_HORIZON_HOURS = 1

function priceable(bar: PriceBar): boolean {
  return bar.finalized && Number.isFinite(bar.open) && bar.open > 0
}

function barHigh(bar: PriceBar): number {
  if (bar.high !== undefined && Number.isFinite(bar.high) && bar.high > 0) return bar.high
  return bar.open
}

/** finalized bars as ledger observations so P0 selection matches firstEligibleObservation */
export function observationsFromBars(bars: readonly PriceBar[]): Observation[] {
  return bars
    .filter(priceable)
    .map((bar) => ({
      ts: bar.ts,
      open: bar.open,
      hash: sha256Bytes(canonicalJson({ ts: bar.ts, open: bar.open })),
    }))
}

function finalizedObservations(bars: readonly PriceBar[]): Observation[] {
  return observationsFromBars(bars)
}

/** earliest finalized eligible bar at or after cutoff (horizon leg) */
function firstAtOrAfter(observations: readonly Observation[], cutoffMs: number): Observation | undefined {
  return observations
    .filter((o) => Date.parse(o.ts) >= cutoffMs)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))[0]
}

export type PeakFromEntry = Readonly<{
  entryOpen: number
  entryTs: string
  peakHigh: number
  peakTs: string
  peakReturn: number
}>

/** Max high after entry open among finalized bars strictly after eventTs */
export function peakFromEntry(
  bars: readonly PriceBar[],
  eventTs: string,
): PeakFromEntry | undefined {
  const entry = firstEligibleObservation(eventTs, observationsFromBars(bars))
  if (!entry) return undefined
  const entryMs = Date.parse(entry.ts)
  let peakHigh = entry.open
  let peakTs = entry.ts
  for (const bar of bars) {
    if (!priceable(bar)) continue
    const ts = Date.parse(bar.ts)
    if (!(ts > entryMs)) continue
    const high = barHigh(bar)
    if (high > peakHigh) {
      peakHigh = high
      peakTs = bar.ts
    }
  }
  return {
    entryOpen: entry.open,
    entryTs: entry.ts,
    peakHigh,
    peakTs,
    peakReturn: peakHigh / entry.open - 1,
  }
}

export function lastHighTs(bars: readonly PriceBar[], afterTs: string): string | undefined {
  const afterMs = Date.parse(afterTs)
  let best: string | undefined
  let bestHigh = -Infinity
  for (const bar of bars) {
    if (!priceable(bar)) continue
    const ts = Date.parse(bar.ts)
    if (!(ts > afterMs)) continue
    const high = barHigh(bar)
    if (high > bestHigh || (high === bestHigh && (!best || ts > Date.parse(best)))) {
      bestHigh = high
      best = bar.ts
    }
  }
  return best
}

/** True when a new high landed within quietHours of now */
export function isStillSending(
  bars: readonly PriceBar[],
  entryTs: string,
  nowIso: string,
  quietHours = PEAK_QUIET_HOURS,
): boolean {
  const last = lastHighTs(bars, entryTs)
  if (!last) return false
  const quietMs = quietHours * HOUR_MS
  return Date.parse(nowIso) - Date.parse(last) < quietMs
}

export type MaterializePeakInput = Readonly<{
  subjectType: OutcomeObservation["subjectType"]
  subjectId: string
  eventTs: string
  bars: readonly PriceBar[]
  observedAt: string
  quietHours?: number
  maxWaitDays?: number
  feeBpsPerSide?: number
}>

/**
 * Peak-from-entry settlement for shill quality. Defers while chart is still
 * making highs within quietHours; force-completes after maxWaitDays.
 */
export function materializePeakObservation(input: MaterializePeakInput): OutcomeObservation {
  const eventMs = Date.parse(input.eventTs)
  if (!Number.isFinite(eventMs)) throw new TypeError("Invalid eventTs")
  const nowMs = Date.parse(input.observedAt)
  const quietHours = input.quietHours ?? PEAK_QUIET_HOURS
  const maxWaitDays = input.maxWaitDays ?? PEAK_MAX_WAIT_DAYS
  const maxWaitMs = maxWaitDays * 86_400_000

  const base = {
    schema: 1 as const,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    horizonHours: PEAK_HORIZON_HOURS,
    observationSpecVersion: 2,
    eventTs: input.eventTs,
    observedAt: input.observedAt,
  }

  const peak = peakFromEntry(input.bars, input.eventTs)
  if (!peak) {
    const retryable = input.bars.some((bar) => (
      !bar.finalized
      && Number.isFinite(bar.open)
      && bar.open > 0
      && Date.parse(bar.ts) > eventMs
    ))
    return OutcomeObservationSchema.parse({
      ...base,
      status: retryable ? "provider-pending" : "censored",
      exclusionReason: retryable
        ? "missing p0: unfinalized bars present, retry pending"
        : "missing p0: no eligible finalized bars",
    })
  }

  const forced = nowMs - eventMs >= maxWaitMs
  const sending = isStillSending(input.bars, peak.entryTs, input.observedAt, quietHours)
  if (sending && !forced) {
    return OutcomeObservationSchema.parse({
      ...base,
      status: "provider-pending",
      exclusionReason: `still-sending: new high within ${quietHours}h`,
      targetPrice: peak.peakHigh,
      rawReturn: peak.peakReturn,
      excessReturn: peak.peakReturn,
      peakTs: peak.peakTs,
      peakPrice: peak.peakHigh,
    })
  }

  const raw = peak.peakReturn
  const costAdjusted = input.feeBpsPerSide !== undefined
    ? applyFeeBps(raw, input.feeBpsPerSide)
    : raw
  return OutcomeObservationSchema.parse({
    ...base,
    status: "complete",
    targetPrice: peak.peakHigh,
    rawReturn: raw,
    excessReturn: costAdjusted,
    peakTs: peak.peakTs,
    peakPrice: peak.peakHigh,
  })
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

/** Open-to-open return between two event timestamps (copy-trade legs) */
export function materializeCopyTradeReturn(args: Readonly<{
  bars: readonly PriceBar[]
  entryTs: string
  exitTs: string
  feeBpsPerSide?: number
}>): number | undefined {
  const obs = observationsFromBars(args.bars)
  const entry = firstEligibleObservation(args.entryTs, obs)
  const exit = firstEligibleObservation(args.exitTs, obs)
  if (!entry || !exit) return undefined
  if (Date.parse(exit.ts) <= Date.parse(entry.ts)) return undefined
  const raw = exit.open / entry.open - 1
  return args.feeBpsPerSide !== undefined
    ? applyFeeBps(raw, args.feeBpsPerSide)
    : raw
}

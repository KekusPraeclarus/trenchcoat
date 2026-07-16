import { sha256Json } from "../../lib/canonical-json.js"
import type { OhlcvCandle } from "./geckoterminal.js"

export const RSI_METHOD = "wilder-close" as const
export const FEATURE_SPEC_VERSION = 1

export type InvalidRsiReason =
  | "gap"
  | "insufficient-active-bars"
  | "insufficient-history"
  | "invalid-parameters"

export type RsiResult =
  | Readonly<{
    valid: true
    method: typeof RSI_METHOD
    period: number
    intervalSeconds: number
    value: number
    previous: number
    delta: number
    inputCount: number
    inputHash: `sha256:${string}`
    lastClosedBarTime: number
  }>
  | Readonly<{
    valid: false
    method: typeof RSI_METHOD
    period: number
    intervalSeconds: number
    reason: InvalidRsiReason
    inputCount: number
    inputHash: `sha256:${string}`
  }>

function inputHash(candles: readonly OhlcvCandle[]): `sha256:${string}` {
  return sha256Json(candles.map((candle) => [
    candle.startTime,
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume,
  ]))
}

function toRsi(averageGain: number, averageLoss: number): number {
  if (averageGain === 0 && averageLoss === 0) {
    return 50
  }

  if (averageLoss === 0) {
    return 100
  }

  if (averageGain === 0) {
    return 0
  }

  return 100 - 100 / (1 + averageGain / averageLoss)
}

function invalidResult(
  candles: readonly OhlcvCandle[],
  period: number,
  intervalSeconds: number,
  reason: InvalidRsiReason,
): RsiResult {
  return {
    valid: false,
    method: RSI_METHOD,
    period,
    intervalSeconds,
    reason,
    inputCount: candles.length,
    inputHash: inputHash(candles),
  }
}

export function computeWilderRsi(
  candles: readonly OhlcvCandle[],
  intervalSeconds: number,
  period = 14,
  minActiveBars = 10,
): RsiResult {
  if (
    !Number.isSafeInteger(intervalSeconds)
    || intervalSeconds < 1
    || !Number.isSafeInteger(period)
    || period < 2
    || !Number.isSafeInteger(minActiveBars)
    || minActiveBars < 0
    || minActiveBars > period
  ) {
    return invalidResult(candles, period, intervalSeconds, "invalid-parameters")
  }

  if (candles.length < period + 2) {
    return invalidResult(candles, period, intervalSeconds, "insufficient-history")
  }

  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1]
    const current = candles[index]

    if (!previous || !current || current.startTime - previous.startTime !== intervalSeconds) {
      return invalidResult(candles, period, intervalSeconds, "gap")
    }
  }

  const activeBars = candles
    .slice(-period)
    .filter((candle) => candle.volume > 0)
    .length

  if (activeBars < minActiveBars) {
    return invalidResult(candles, period, intervalSeconds, "insufficient-active-bars")
  }

  const changes: number[] = []
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1]
    const current = candles[index]
    if (!previous || !current) {
      return invalidResult(candles, period, intervalSeconds, "gap")
    }
    changes.push(current.close - previous.close)
  }

  const seed = changes.slice(0, period)
  let averageGain = seed.reduce((sum, change) => sum + Math.max(change, 0), 0) / period
  let averageLoss = seed.reduce((sum, change) => sum + Math.max(-change, 0), 0) / period
  let previousRsi = toRsi(averageGain, averageLoss)
  let currentRsi = previousRsi

  for (const change of changes.slice(period)) {
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period
    previousRsi = currentRsi
    currentRsi = toRsi(averageGain, averageLoss)
  }

  const last = candles.at(-1)
  if (!last) {
    return invalidResult(candles, period, intervalSeconds, "insufficient-history")
  }

  return {
    valid: true,
    method: RSI_METHOD,
    period,
    intervalSeconds,
    value: currentRsi,
    previous: previousRsi,
    delta: currentRsi - previousRsi,
    inputCount: candles.length,
    inputHash: inputHash(candles),
    lastClosedBarTime: last.startTime,
  }
}

export type FeatureResult<T> = Readonly<{
  valid: boolean
  featureSpecVersion: typeof FEATURE_SPEC_VERSION
  inputHash: `sha256:${string}`
  value?: T
  reason?: "gap" | "insufficient-history" | "invalid-parameters" | "pair-migration"
}>

function contiguous(
  candles: readonly OhlcvCandle[],
  intervalSeconds: number,
  minLength: number,
): FeatureResult<readonly OhlcvCandle[]> {
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1 || minLength < 1) {
    return { valid: false, featureSpecVersion: FEATURE_SPEC_VERSION, inputHash: inputHash(candles), reason: "invalid-parameters" }
  }
  if (candles.length < minLength) {
    return { valid: false, featureSpecVersion: FEATURE_SPEC_VERSION, inputHash: inputHash(candles), reason: "insufficient-history" }
  }
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index]!.startTime - candles[index - 1]!.startTime !== intervalSeconds) {
      return { valid: false, featureSpecVersion: FEATURE_SPEC_VERSION, inputHash: inputHash(candles), reason: "gap" }
    }
  }
  return { valid: true, featureSpecVersion: FEATURE_SPEC_VERSION, inputHash: inputHash(candles), value: candles }
}

function invalidFeature<T>(state: FeatureResult<readonly OhlcvCandle[]>): FeatureResult<T> {
  return {
    valid: false,
    featureSpecVersion: FEATURE_SPEC_VERSION,
    inputHash: state.inputHash,
    reason: state.reason ?? "invalid-parameters",
  }
}

export function computeVolumeZScore(
  candles: readonly OhlcvCandle[],
  intervalSeconds: number,
  baselineBars = 168,
  recentBars = 24,
): FeatureResult<number> {
  const state = contiguous(candles, intervalSeconds, baselineBars + recentBars)
  if (!state.valid || !state.value) return invalidFeature(state)
  const baseline = state.value.slice(-(baselineBars + recentBars), -recentBars).map((candle) => candle.volume)
  const recent = state.value.slice(-recentBars).map((candle) => candle.volume)
  const mean = baseline.reduce((sum, value) => sum + value, 0) / baseline.length
  const variance = baseline.reduce((sum, value) => sum + (value - mean) ** 2, 0) / baseline.length
  const deviation = Math.sqrt(variance)
  const current = recent.reduce((sum, value) => sum + value, 0) / recent.length
  return {
    valid: true,
    featureSpecVersion: FEATURE_SPEC_VERSION,
    inputHash: state.inputHash,
    value: deviation === 0 ? (current === mean ? 0 : Number.POSITIVE_INFINITY) : (current - mean) / deviation,
  }
}

export function computeEmaStructure(
  candles: readonly OhlcvCandle[],
  intervalSeconds: number,
): FeatureResult<Readonly<{ ema9: number; ema21: number; ema50: number; structure: "bullish" | "bearish" | "mixed" }>> {
  const state = contiguous(candles, intervalSeconds, 50)
  if (!state.valid || !state.value) return invalidFeature(state)
  const ema = (period: number): number => {
    const multiplier = 2 / (period + 1)
    return state.value!.slice(-period).reduce(
      (previous, candle, index) => index === 0 ? candle.close : candle.close * multiplier + previous * (1 - multiplier),
      state.value!.at(-period)!.close,
    )
  }
  const ema9 = ema(9)
  const ema21 = ema(21)
  const ema50 = ema(50)
  return {
    valid: true,
    featureSpecVersion: FEATURE_SPEC_VERSION,
    inputHash: state.inputHash,
    value: {
      ema9,
      ema21,
      ema50,
      structure: ema9 > ema21 && ema21 > ema50 ? "bullish" : ema9 < ema21 && ema21 < ema50 ? "bearish" : "mixed",
    },
  }
}

export function computeRangeBreakout(
  candles: readonly OhlcvCandle[],
  intervalSeconds: number,
  lookbackBars = 168,
): FeatureResult<"up" | "down" | "none"> {
  const state = contiguous(candles, intervalSeconds, lookbackBars + 1)
  if (!state.valid || !state.value) return invalidFeature(state)
  const prior = state.value.slice(-(lookbackBars + 1), -1)
  const latest = state.value.at(-1)!
  const high = Math.max(...prior.map((candle) => candle.high))
  const low = Math.min(...prior.map((candle) => candle.low))
  return {
    valid: true,
    featureSpecVersion: FEATURE_SPEC_VERSION,
    inputHash: state.inputHash,
    value: latest.close > high ? "up" : latest.close < low ? "down" : "none",
  }
}

export function computeLiquidityDelta(
  previousUsd: number,
  currentUsd: number,
): FeatureResult<number> {
  const values = [{ startTime: 0, open: previousUsd, high: previousUsd, low: previousUsd, close: previousUsd, volume: currentUsd }]
  if (!Number.isFinite(previousUsd) || previousUsd <= 0 || !Number.isFinite(currentUsd) || currentUsd < 0) {
    return { valid: false, featureSpecVersion: FEATURE_SPEC_VERSION, inputHash: inputHash(values), reason: "invalid-parameters" }
  }
  return {
    valid: true,
    featureSpecVersion: FEATURE_SPEC_VERSION,
    inputHash: inputHash(values),
    value: (currentUsd - previousUsd) / previousUsd,
  }
}

export function computeBenchmarkVolatility(
  candles: readonly OhlcvCandle[],
  intervalSeconds: number,
  lookbackBars = 24,
): FeatureResult<number> {
  const state = contiguous(candles, intervalSeconds, lookbackBars + 1)
  if (!state.valid || !state.value) return invalidFeature(state)
  const returns = state.value.slice(-lookbackBars).map((candle, index, values) => (
    index === 0 ? Math.log(candle.close / state.value![state.value!.length - lookbackBars - 1]!.close) : Math.log(candle.close / values[index - 1]!.close)
  ))
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length
  return {
    valid: true,
    featureSpecVersion: FEATURE_SPEC_VERSION,
    inputHash: state.inputHash,
    value: Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length),
  }
}

export function pairMigrationDiscontinuity(
  previousPairAddress: string | undefined,
  pairAddress: string,
): FeatureResult<boolean> {
  const value = previousPairAddress !== undefined && previousPairAddress !== pairAddress
  return {
    valid: !value,
    featureSpecVersion: FEATURE_SPEC_VERSION,
    inputHash: sha256Json([previousPairAddress ?? null, pairAddress]),
    value,
    ...(value ? { reason: "pair-migration" as const } : {}),
  }
}

import { sha256Json } from "../../lib/canonical-json.js"
import type { OhlcvCandle } from "./geckoterminal.js"

export const RSI_METHOD = "wilder-close" as const

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

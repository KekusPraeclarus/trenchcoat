import type { OhlcvCandle } from "./geckoterminal.js"

/** Aggregate closed finer bars into closed coarser bars. Gaps yield incomplete groups that are dropped. */
export function aggregateClosedCandles(
  candles: readonly OhlcvCandle[],
  fromIntervalSeconds: number,
  toIntervalSeconds: number,
): OhlcvCandle[] {
  if (
    !Number.isSafeInteger(fromIntervalSeconds)
    || fromIntervalSeconds < 1
    || !Number.isSafeInteger(toIntervalSeconds)
    || toIntervalSeconds < fromIntervalSeconds
    || toIntervalSeconds % fromIntervalSeconds !== 0
  ) {
    throw new TypeError("Invalid candle aggregation intervals")
  }
  const ratio = toIntervalSeconds / fromIntervalSeconds
  const byBucket = new Map<number, OhlcvCandle[]>()
  for (const candle of candles) {
    if (candle.startTime % fromIntervalSeconds !== 0) continue
    const bucket = Math.floor(candle.startTime / toIntervalSeconds) * toIntervalSeconds
    const list = byBucket.get(bucket) ?? []
    list.push(candle)
    byBucket.set(bucket, list)
  }
  const out: OhlcvCandle[] = []
  for (const [bucket, group] of [...byBucket.entries()].sort((a, b) => a[0] - b[0])) {
    if (group.length !== ratio) continue
    const sorted = [...group].sort((a, b) => a.startTime - b.startTime)
    let contiguous = true
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i]!.startTime - sorted[i - 1]!.startTime !== fromIntervalSeconds) {
        contiguous = false
        break
      }
    }
    if (!contiguous || sorted[0]!.startTime !== bucket) continue
    out.push({
      startTime: bucket,
      open: sorted[0]!.open,
      high: Math.max(...sorted.map((c) => c.high)),
      low: Math.min(...sorted.map((c) => c.low)),
      close: sorted.at(-1)!.close,
      volume: sorted.reduce((sum, c) => sum + c.volume, 0),
    })
  }
  return out
}

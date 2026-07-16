export function ema(values: readonly number[], period: number): number[] {
  if (period < 1 || values.length === 0) return []
  const k = 2 / (period + 1)
  const out: number[] = []
  let prev = values[0]!
  out.push(prev)
  for (let i = 1; i < values.length; i += 1) {
    prev = values[i]! * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}

export function volumeZScore(volumes: readonly number[], lookback: number): number | undefined {
  if (volumes.length < lookback + 1) return undefined
  const window = volumes.slice(-lookback - 1, -1)
  const current = volumes[volumes.length - 1]!
  const mean = window.reduce((a, b) => a + b, 0) / window.length
  const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length
  const std = Math.sqrt(variance)
  if (std === 0) return 0
  return (current - mean) / std
}

export function breakoutHigh(closes: readonly number[], lookback: number): boolean {
  if (closes.length < lookback + 1) return false
  const current = closes[closes.length - 1]!
  const prior = closes.slice(-lookback - 1, -1)
  return current > Math.max(...prior)
}

export function liquidityDelta(prevUsd: number, nextUsd: number): number {
  if (prevUsd <= 0) return 0
  return (nextUsd - prevUsd) / prevUsd
}

export function benchmarkVolatility(returns: readonly number[]): number | undefined {
  if (returns.length < 2) return undefined
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1)
  return Math.sqrt(variance)
}

export function pairMigrationDiscontinuity(
  oldPairLastClose: number,
  newPairFirstOpen: number,
  threshold = 0.15,
): boolean {
  if (oldPairLastClose <= 0) return true
  return Math.abs(newPairFirstOpen - oldPairLastClose) / oldPairLastClose > threshold
}

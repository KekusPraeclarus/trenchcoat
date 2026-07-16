export function wilsonLowerBound(
  successes: number,
  total: number,
  z = 1.96,
): number {
  if (total <= 0) return 0
  const p = successes / total
  const denom = 1 + (z * z) / total
  const centre = p + (z * z) / (2 * total)
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)
  return Math.max(0, (centre - margin) / denom)
}

export function brierScore(forecasts: readonly number[], outcomes: readonly number[]): number {
  if (forecasts.length === 0 || forecasts.length !== outcomes.length) {
    throw new Error("brier inputs mismatch")
  }
  let sum = 0
  for (let i = 0; i < forecasts.length; i += 1) {
    const f = forecasts[i]!
    const o = outcomes[i]!
    sum += (f - o) ** 2
  }
  return sum / forecasts.length
}

export function excessReturn(assetReturn: number, benchmarkReturn: number): number {
  return assetReturn - benchmarkReturn
}

export function applyFeeBps(rawReturn: number, feeBpsPerSide: number): number {
  const fee = (feeBpsPerSide * 2) / 10_000
  return rawReturn - fee
}

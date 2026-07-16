import { createHash } from "node:crypto"

export type Candle = Readonly<{
  ts: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}>

export type ChartManifest = Readonly<{
  schema: 1
  pair: string
  timeframeMinutes: number
  featureSpecVersion: number
  candleHash: `sha256:${string}`
  imageHash: `sha256:${string}`
  cutoffTs: number
}>

export function candleHash(candles: readonly Candle[]): `sha256:${string}` {
  const body = candles.map((c) => `${c.ts}:${c.open}:${c.high}:${c.low}:${c.close}:${c.volume}`).join("|")
  return `sha256:${createHash("sha256").update(body).digest("hex")}`
}

/** Deterministic offline SVG — no network fonts/assets */
export function renderSparklineSvg(candles: readonly Candle[], width = 640, height = 240): string {
  if (candles.length < 2) {
    throw new Error("Need at least two closed candles")
  }
  const closes = candles.map((c) => c.close)
  const min = Math.min(...closes)
  const max = Math.max(...closes)
  const span = max - min || 1
  const step = width / (closes.length - 1)
  const points = closes.map((close, i) => {
    const x = i * step
    const y = height - ((close - min) / span) * (height - 20) - 10
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }).join(" ")
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#0b0f14"/><polyline fill="none" stroke="#5eead4" stroke-width="2" points="${points}"/></svg>\n`
}

export function svgToPngPlaceholder(svg: string): Buffer {
  // True PNG encoding would need a native/canvas dep; keep deterministic bytes for manifests.
  // Prefix makes format explicit; hash remains stable for a given SVG.
  return Buffer.from(`PNG-PLACEHOLDER\n${svg}`, "utf8")
}

export function buildChartManifest(args: Readonly<{
  pair: string
  timeframeMinutes: number
  featureSpecVersion: number
  candles: readonly Candle[]
  imageBytes: Buffer
}>): ChartManifest {
  const imageHash = `sha256:${createHash("sha256").update(args.imageBytes).digest("hex")}` as const
  const last = args.candles[args.candles.length - 1]
  if (!last) throw new Error("empty candles")
  return {
    schema: 1,
    pair: args.pair,
    timeframeMinutes: args.timeframeMinutes,
    featureSpecVersion: args.featureSpecVersion,
    candleHash: candleHash(args.candles),
    imageHash,
    cutoffTs: last.ts,
  }
}

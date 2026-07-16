import { deflateSync } from "node:zlib"
import { createHash } from "node:crypto"
import { sha256Bytes } from "../lib/fs-atomic.js"
import { FEATURE_SPEC_VERSION } from "../collectors/market/indicators.js"
import type { OhlcvCandle } from "../collectors/market/geckoterminal.js"

export type ChartManifest = Readonly<{
  candleHash: `sha256:${string}`
  imageHash: `sha256:${string}`
  pairAddress: string
  timeframeSeconds: number
  featureSpecVersion: number
  barCutoff: number
}>

const WIDTH = 960
const HEIGHT = 540

function assertCandles(candles: readonly OhlcvCandle[], timeframeSeconds: number): void {
  if (!Number.isSafeInteger(timeframeSeconds) || timeframeSeconds < 1 || candles.length < 2 || candles.length > 1_000) throw new TypeError("Invalid chart candle series")
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index]!.startTime - candles[index - 1]!.startTime !== timeframeSeconds) throw new TypeError("Chart candles must be contiguous closed bars")
  }
}

export function renderChartSvg(candles: readonly OhlcvCandle[], timeframeSeconds: number): string {
  assertCandles(candles, timeframeSeconds)
  const low = Math.min(...candles.map((candle) => candle.low))
  const high = Math.max(...candles.map((candle) => candle.high))
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) throw new TypeError("Chart price range must be positive")
  const x = (index: number) => 40 + index * (880 / (candles.length - 1))
  const y = (value: number) => 20 + (high - value) / (high - low) * 480
  const bars = candles.map((candle, index) => {
    const color = candle.close >= candle.open ? "#22c55e" : "#ef4444"
    const width = Math.max(1, 700 / candles.length)
    return `<line x1="${x(index)}" y1="${y(candle.high)}" x2="${x(index)}" y2="${y(candle.low)}" stroke="${color}"/><rect x="${x(index) - width / 2}" y="${y(Math.max(candle.open, candle.close))}" width="${width}" height="${Math.max(1, Math.abs(y(candle.open) - y(candle.close)))}" fill="${color}"/>`
  }).join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><rect width="100%" height="100%" fill="#0b1020"/>${bars}</svg>`
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const name = Buffer.from(type, "ascii")
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}

export function renderChartPng(candles: readonly OhlcvCandle[], timeframeSeconds: number): Buffer {
  renderChartSvg(candles, timeframeSeconds)
  const pixels = Buffer.alloc((WIDTH * 4 + 1) * HEIGHT)
  for (let y = 0; y < HEIGHT; y += 1) {
    const row = y * (WIDTH * 4 + 1)
    pixels[row] = 0
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = row + 1 + x * 4
      pixels[offset] = 11
      pixels[offset + 1] = 16
      pixels[offset + 2] = 32
      pixels[offset + 3] = 255
    }
  }
  const low = Math.min(...candles.map((candle) => candle.low))
  const high = Math.max(...candles.map((candle) => candle.high))
  const pointY = (value: number) => Math.round(20 + (high - value) / (high - low) * 480)
  for (const [index, candle] of candles.entries()) {
    const x = Math.round(40 + index * (880 / (candles.length - 1)))
    const green = candle.close >= candle.open
    for (let y = pointY(candle.high); y <= pointY(candle.low); y += 1) {
      if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) continue
      const offset = y * (WIDTH * 4 + 1) + 1 + x * 4
      pixels[offset] = green ? 34 : 239
      pixels[offset + 1] = green ? 197 : 68
      pixels[offset + 2] = green ? 94 : 68
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(WIDTH, 0)
  header.writeUInt32BE(HEIGHT, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))])
}

export function chartManifest(
  candles: readonly OhlcvCandle[],
  pairAddress: string,
  timeframeSeconds: number,
): ChartManifest {
  if (!/^[A-Za-z0-9]{1,128}$/u.test(pairAddress)) throw new TypeError("Invalid pair address")
  const png = renderChartPng(candles, timeframeSeconds)
  const cutoff = candles.at(-1)!.startTime + timeframeSeconds
  return {
    candleHash: `sha256:${createHash("sha256").update(JSON.stringify(candles)).digest("hex")}`,
    imageHash: sha256Bytes(png),
    pairAddress,
    timeframeSeconds,
    featureSpecVersion: FEATURE_SPEC_VERSION,
    barCutoff: cutoff,
  }
}

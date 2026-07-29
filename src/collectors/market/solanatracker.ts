import { gatedFetchWithRetry, readJsonBody } from "../../lib/http.js"
import type { FetchLike, OhlcvCandle } from "./geckoterminal.js"

const SOLANATRACKER_ROOT = "https://data.solanatracker.io"
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const SAFE_MINT = /^[A-HJ-NP-Za-km-z1-9]{32,44}$/u

const INTERVAL_SECONDS: Readonly<Record<string, number>> = Object.freeze({
  "1s": 1,
  "5s": 5,
  "15s": 15,
  "1m": 60,
  "3m": 3 * 60,
  "5m": 5 * 60,
  "15m": 15 * 60,
  "30m": 30 * 60,
  "1h": 60 * 60,
  "2h": 2 * 60 * 60,
  "4h": 4 * 60 * 60,
})

function parseCandleRow(raw: unknown, intervalSeconds: number): OhlcvCandle | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const time = Reflect.get(raw, "time")
  const open = Reflect.get(raw, "open")
  const high = Reflect.get(raw, "high")
  const low = Reflect.get(raw, "low")
  const close = Reflect.get(raw, "close")
  const volume = Reflect.get(raw, "volume")
  if (
    typeof time !== "number" || !Number.isFinite(time)
    || typeof open !== "number" || !Number.isFinite(open)
    || typeof high !== "number" || !Number.isFinite(high)
    || typeof low !== "number" || !Number.isFinite(low)
    || typeof close !== "number" || !Number.isFinite(close)
    || typeof volume !== "number" || !Number.isFinite(volume) || volume < 0
  ) {
    return undefined
  }
  const startTime = Math.trunc(time)
  if (startTime % intervalSeconds !== 0) return undefined
  if (high < Math.max(open, low, close) || low > Math.min(open, high, close)) return undefined
  return { startTime, open, high, low, close, volume }
}

export function parseSolanaTrackerOhlcv(
  payload: unknown,
  intervalType: string,
  asOfEpochSeconds: number,
): OhlcvCandle[] {
  const intervalSeconds = INTERVAL_SECONDS[intervalType]
  if (!intervalSeconds) throw new TypeError(`Unsupported SolanaTracker interval: ${intervalType}`)

  let rows: unknown[] | undefined
  if (Array.isArray(payload)) {
    rows = payload
  } else if (payload !== null && typeof payload === "object") {
    const ohlcv = Reflect.get(payload, "ohlcv")
    if (Array.isArray(ohlcv)) rows = ohlcv
    else {
      const data = Reflect.get(payload, "data")
      if (Array.isArray(data)) rows = data
      else if (data !== null && typeof data === "object") {
        const nested = Reflect.get(data, "ohlcv")
        if (Array.isArray(nested)) rows = nested
      }
    }
  }
  if (!rows) throw new TypeError("SolanaTracker response has no OHLCV array")

  const byStart = new Map<number, OhlcvCandle>()
  for (const raw of rows) {
    const candle = parseCandleRow(raw, intervalSeconds)
    if (!candle) continue
    if (candle.startTime + intervalSeconds <= asOfEpochSeconds) {
      byStart.set(candle.startTime, candle)
    }
  }
  return [...byStart.values()].sort((a, b) => a.startTime - b.startTime)
}

export async function fetchSolanaTrackerOhlcv(args: Readonly<{
  fetcher: FetchLike
  tokenAddress: string
  intervalType?: string
  asOfEpochSeconds: number
  apiKey: string
  timeFrom?: number
  timeTo?: number
}>): Promise<OhlcvCandle[]> {
  if (!SAFE_MINT.test(args.tokenAddress)) {
    throw new TypeError("Invalid Solana token address")
  }
  const intervalType = args.intervalType ?? "15m"
  const url = new URL(`${SOLANATRACKER_ROOT}/chart/${encodeURIComponent(args.tokenAddress)}`)
  url.searchParams.set("type", intervalType)
  if (args.timeFrom !== undefined) url.searchParams.set("time_from", String(args.timeFrom))
  if (args.timeTo !== undefined) url.searchParams.set("time_to", String(args.timeTo))

  const response = await gatedFetchWithRetry(args.fetcher, url, {
    host: "data.solanatracker.io",
    capacity: 3,
    refillPerSecond: 3,
    headers: {
      accept: "application/json",
      "x-api-key": args.apiKey,
    },
  })
  if (!response.ok) {
    throw new Error(`SolanaTracker OHLCV request failed with HTTP ${response.status}`)
  }
  const payload = await readJsonBody(response, MAX_RESPONSE_BYTES)
  return parseSolanaTrackerOhlcv(payload, intervalType, args.asOfEpochSeconds)
}

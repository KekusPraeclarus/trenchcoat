import { gatedFetchWithRetry, readJsonBody } from "../../lib/http.js"
import type { FetchLike, OhlcvCandle } from "./geckoterminal.js"

const BIRDEYE_ROOT = "https://public-api.birdeye.so"
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const SAFE_SOLANA = /^[A-HJ-NP-Za-km-z1-9]{32,44}$/u
const SAFE_EVM = /^0x[a-fA-F0-9]{40}$/u

/** Birdeye `x-chain` values we use for OHLCV fallback. */
export type BirdeyeChain = "solana" | "ethereum" | "base" | "bsc"

const INTERVAL_SECONDS: Readonly<Record<string, number>> = Object.freeze({
  "1m": 60,
  "3m": 3 * 60,
  "5m": 5 * 60,
  "15m": 15 * 60,
  "30m": 30 * 60,
  "1H": 60 * 60,
  "2H": 2 * 60 * 60,
  "4H": 4 * 60 * 60,
  "1h": 60 * 60,
  "2h": 2 * 60 * 60,
  "4h": 4 * 60 * 60,
})

/** Map trenchcoat chain slug → Birdeye x-chain, or undefined if unsupported. */
export function birdeyeChainForSlug(slug: string): BirdeyeChain | undefined {
  switch (slug) {
    case "solana":
      return "solana"
    case "ethereum":
      return "ethereum"
    case "base":
      return "base"
    case "bsc":
      return "bsc"
    default:
      return undefined
  }
}

function numField(obj: object, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = Reflect.get(obj, key)
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

function parseCandleRow(raw: unknown, intervalSeconds: number): OhlcvCandle | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const time = numField(raw, "unixTime", "time", "t")
  const open = numField(raw, "o", "open")
  const high = numField(raw, "h", "high")
  const low = numField(raw, "l", "low")
  const close = numField(raw, "c", "close")
  const volume = numField(raw, "v", "volume")
  if (
    time === undefined || open === undefined || high === undefined
    || low === undefined || close === undefined || volume === undefined || volume < 0
  ) {
    return undefined
  }
  const startTime = Math.trunc(time)
  if (startTime % intervalSeconds !== 0) return undefined
  if (high < Math.max(open, low, close) || low > Math.min(open, high, close)) return undefined
  return { startTime, open, high, low, close, volume }
}

export function parseBirdeyeOhlcv(
  payload: unknown,
  intervalType: string,
  asOfEpochSeconds: number,
): OhlcvCandle[] {
  const intervalSeconds = INTERVAL_SECONDS[intervalType]
  if (!intervalSeconds) throw new TypeError(`Unsupported Birdeye interval: ${intervalType}`)

  let rows: unknown[] | undefined
  if (payload !== null && typeof payload === "object") {
    const data = Reflect.get(payload, "data")
    if (data !== null && typeof data === "object") {
      const items = Reflect.get(data, "items")
      if (Array.isArray(items)) rows = items
    }
    if (!rows && Array.isArray(payload)) rows = payload
  }
  if (!rows) throw new TypeError("Birdeye response has no OHLCV items")

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

function assertBirdeyeAddress(chain: BirdeyeChain, tokenAddress: string): void {
  if (chain === "solana") {
    if (!SAFE_SOLANA.test(tokenAddress)) {
      throw new TypeError("Invalid Birdeye Solana token address")
    }
    return
  }
  if (!SAFE_EVM.test(tokenAddress)) {
    throw new TypeError(`Invalid Birdeye ${chain} token address`)
  }
}

export async function fetchBirdeyeOhlcv(args: Readonly<{
  fetcher: FetchLike
  tokenAddress: string
  /** Birdeye x-chain; defaults to solana for backward compatibility */
  chain?: BirdeyeChain
  intervalType?: string
  asOfEpochSeconds: number
  apiKey: string
  timeFrom?: number
  timeTo?: number
}>): Promise<OhlcvCandle[]> {
  const chain = args.chain ?? "solana"
  assertBirdeyeAddress(chain, args.tokenAddress)
  const intervalType = args.intervalType ?? "15m"
  const url = new URL(`${BIRDEYE_ROOT}/defi/v3/ohlcv`)
  url.searchParams.set("address", args.tokenAddress)
  url.searchParams.set("type", intervalType)
  if (args.timeFrom !== undefined) url.searchParams.set("time_from", String(args.timeFrom))
  if (args.timeTo !== undefined) url.searchParams.set("time_to", String(args.timeTo))

  const response = await gatedFetchWithRetry(args.fetcher, url, {
    host: "public-api.birdeye.so",
    capacity: 1,
    refillPerSecond: 1,
    headers: {
      accept: "application/json",
      "X-API-KEY": args.apiKey,
      "x-chain": chain,
    },
  })
  if (!response.ok) {
    throw new Error(`Birdeye OHLCV request failed with HTTP ${response.status}`)
  }
  const payload = await readJsonBody(response, MAX_RESPONSE_BYTES)
  return parseBirdeyeOhlcv(payload, intervalType, args.asOfEpochSeconds)
}

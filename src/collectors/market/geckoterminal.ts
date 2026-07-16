export const GECKOTERMINAL_ROOT = "https://api.geckoterminal.com/api/v2"
export const GECKOTERMINAL_API_VERSION = "20230302"
export const FIVE_MINUTES_SECONDS = 300

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const MAX_CANDLES_PER_RESPONSE = 1_000
const SAFE_NETWORK = /^[a-z0-9-]+$/
const SAFE_ADDRESS = /^[A-Za-z0-9]+$/

export type OhlcvCandle = Readonly<{
  startTime: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}>

export type GeckoOhlcvRequest = Readonly<{
  network: string
  poolAddress: string
  aggregateMinutes: 1 | 5 | 15
  limit: number
  beforeTimestamp?: number
}>

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

function assertEpochSeconds(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative epoch-second integer`)
  }
}

function assertFiniteNonNegative(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a finite non-negative number`)
  }
}

function parseCandle(value: unknown, intervalSeconds: number): OhlcvCandle {
  if (!Array.isArray(value) || value.length !== 6) {
    throw new TypeError("OHLCV candle must contain exactly six values")
  }

  const [startTime, open, high, low, close, volume] = value
  assertFiniteNonNegative(startTime, "candle timestamp")
  assertFiniteNonNegative(open, "candle open")
  assertFiniteNonNegative(high, "candle high")
  assertFiniteNonNegative(low, "candle low")
  assertFiniteNonNegative(close, "candle close")
  assertFiniteNonNegative(volume, "candle volume")
  assertEpochSeconds(startTime, "candle timestamp")

  if (startTime % intervalSeconds !== 0) {
    throw new TypeError("OHLCV candle is not aligned to its interval")
  }

  if (high < Math.max(open, low, close) || low > Math.min(open, high, close)) {
    throw new TypeError("OHLCV candle bounds are inconsistent")
  }

  return { startTime, open, high, low, close, volume }
}

function readOhlcvList(payload: unknown): unknown[] {
  if (payload === null || typeof payload !== "object") {
    throw new TypeError("GeckoTerminal response must be an object")
  }

  const data = Reflect.get(payload, "data")
  const attributes = data !== null && typeof data === "object"
    ? Reflect.get(data, "attributes")
    : undefined
  const list = attributes !== null && typeof attributes === "object"
    ? Reflect.get(attributes, "ohlcv_list")
    : undefined

  if (!Array.isArray(list) || list.length > MAX_CANDLES_PER_RESPONSE) {
    throw new TypeError("GeckoTerminal response has an invalid OHLCV list")
  }

  return list
}

export function parseClosedOhlcv(
  payload: unknown,
  intervalSeconds: number,
  asOfEpochSeconds: number,
): OhlcvCandle[] {
  assertEpochSeconds(intervalSeconds, "intervalSeconds")
  assertEpochSeconds(asOfEpochSeconds, "asOfEpochSeconds")

  if (intervalSeconds === 0) {
    throw new TypeError("intervalSeconds must be positive")
  }

  const byStart = new Map<number, OhlcvCandle>()

  for (const rawCandle of readOhlcvList(payload)) {
    const candle = parseCandle(rawCandle, intervalSeconds)
    const existing = byStart.get(candle.startTime)

    if (existing && JSON.stringify(existing) !== JSON.stringify(candle)) {
      throw new TypeError(`Conflicting OHLCV candles at ${candle.startTime}`)
    }

    if (candle.startTime + intervalSeconds <= asOfEpochSeconds) {
      byStart.set(candle.startTime, candle)
    }
  }

  return [...byStart.values()].sort((left, right) => left.startTime - right.startTime)
}

export function nextBeforeTimestamp(
  oldestStartTime: number,
  intervalSeconds: number,
): number {
  assertEpochSeconds(oldestStartTime, "oldestStartTime")
  assertEpochSeconds(intervalSeconds, "intervalSeconds")

  if (intervalSeconds === 0 || oldestStartTime < intervalSeconds) {
    throw new RangeError("Cannot paginate before the oldest candle")
  }

  return oldestStartTime - intervalSeconds
}

export function firstExecutionCandle(
  candles: readonly OhlcvCandle[],
  eventTimestamp: number,
): OhlcvCandle | undefined {
  assertEpochSeconds(eventTimestamp, "eventTimestamp")
  return candles.find((candle) => candle.startTime >= eventTimestamp)
}

export function buildGeckoOhlcvUrl(request: GeckoOhlcvRequest): URL {
  if (!SAFE_NETWORK.test(request.network)) {
    throw new TypeError("Invalid GeckoTerminal network slug")
  }

  if (!SAFE_ADDRESS.test(request.poolAddress)) {
    throw new TypeError("Invalid GeckoTerminal pool address")
  }

  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_000) {
    throw new TypeError("OHLCV limit must be an integer from 1 to 1000")
  }

  const url = new URL(
    `${GECKOTERMINAL_ROOT}/networks/${request.network}/pools/${request.poolAddress}/ohlcv/minute`,
  )
  url.searchParams.set("aggregate", String(request.aggregateMinutes))
  url.searchParams.set("limit", String(request.limit))
  url.searchParams.set("currency", "usd")

  if (request.beforeTimestamp !== undefined) {
    assertEpochSeconds(request.beforeTimestamp, "beforeTimestamp")
    url.searchParams.set("before_timestamp", String(request.beforeTimestamp))
  }

  return url
}

export async function fetchClosedOhlcv(
  fetcher: FetchLike,
  request: GeckoOhlcvRequest,
  asOfEpochSeconds: number,
  timeoutMs = 10_000,
): Promise<OhlcvCandle[]> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError("timeoutMs must be an integer from 1 to 60000")
  }

  const response = await fetcher(buildGeckoOhlcvUrl(request), {
    headers: {
      accept: `application/json;version=${GECKOTERMINAL_API_VERSION}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    throw new Error(`GeckoTerminal OHLCV request failed with HTTP ${response.status}`)
  }

  const contentType = response.headers.get("content-type")
  if (!contentType?.toLowerCase().includes("application/json")) {
    throw new TypeError("GeckoTerminal returned a non-JSON response")
  }

  const declaredLength = Number(response.headers.get("content-length") ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new RangeError("GeckoTerminal response exceeds the size limit")
  }

  const body = await response.text()
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    throw new RangeError("GeckoTerminal response exceeds the size limit")
  }

  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    throw new TypeError("GeckoTerminal returned malformed JSON")
  }

  return parseClosedOhlcv(
    payload,
    request.aggregateMinutes * 60,
    asOfEpochSeconds,
  )
}

import type { FetchLike } from "../collectors/market/geckoterminal.js"
import { getRateGate } from "./rate-gate.js"

const MAX_DEFAULT_BYTES = 5 * 1024 * 1024

export type GatedFetchOptions = Readonly<{
  host: string
  capacity: number
  refillPerSecond: number
  monthlyBudget?: number
  minIntervalMs?: number
  /** Token / credit cost consumed per take (default 1) */
  cost?: number
  maxBytes?: number
  timeoutMs?: number
  headers?: HeadersInit
}>

export async function gatedFetch(
  fetcher: FetchLike,
  url: string | URL,
  options: GatedFetchOptions,
  init: RequestInit = {},
): Promise<Response> {
  const gate = getRateGate(options.host, {
    capacity: options.capacity,
    refillPerSecond: options.refillPerSecond,
    ...(options.monthlyBudget === undefined
      ? {}
      : { monthlyBudget: options.monthlyBudget }),
    ...(options.minIntervalMs === undefined
      ? {}
      : { minIntervalMs: options.minIntervalMs }),
  })
  await gate.take(options.cost ?? 1)

  const response = await fetcher(url, {
    ...init,
    headers: {
      ...(options.headers ?? {}),
      ...(init.headers ?? {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  })

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after") ?? NaN)
    gate.observe429(Number.isFinite(retryAfter) ? retryAfter : undefined)
  }

  const maxBytes = options.maxBytes ?? MAX_DEFAULT_BYTES
  const declared = Number(response.headers.get("content-length") ?? 0)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RangeError(`Response from ${options.host} exceeds size limit`)
  }

  return response
}

export type GatedFetchRetryOptions = GatedFetchOptions & Readonly<{
  maxAttempts?: number
  // Retry-After beyond this many seconds is ignored in favour of bounded backoff
  retryAfterCapSeconds?: number
  // Injectable delay for deterministic tests; defaults to real sleep
  sleep?: (ms: number) => Promise<void>
}>

// Monthly budget exhaustion is a hard stop, never a transient failure
const BUDGET_EXHAUSTED = /Monthly budget exhausted/u

function isRetryableFetchError(error: unknown): boolean {
  if (error instanceof RangeError) return false
  if (error instanceof Error && BUDGET_EXHAUSTED.test(error.message)) return false
  const name = error instanceof Error ? error.name : ""
  // AbortSignal.timeout rejects with a TimeoutError/AbortError; undici surfaces
  // network failures (incl. redirect:"error") as a bare TypeError "fetch failed"
  if (name === "TimeoutError" || name === "AbortError") return true
  return error instanceof TypeError
}

function backoffMs(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 8_000) + Math.floor(Math.random() * 251)
}

function retryDelayMs(response: Response, attempt: number, capSeconds: number): number {
  const retryAfter = Number(response.headers.get("retry-after") ?? NaN)
  if (Number.isFinite(retryAfter) && retryAfter >= 0 && retryAfter <= capSeconds) {
    return Math.ceil(retryAfter * 1_000)
  }
  return backoffMs(attempt)
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * gatedFetch with bounded retries. Every attempt still passes through the shared
 * rate gate, so the token bucket and 429 backoff stay authoritative. Retries only
 * cover transient failures (HTTP 429, 5xx, timeout/abort/network); ordinary 4xx,
 * size-limit RangeErrors, and monthly-budget exhaustion fail closed immediately.
 */
export async function gatedFetchWithRetry(
  fetcher: FetchLike,
  url: string | URL,
  options: GatedFetchRetryOptions,
  init: RequestInit = {},
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? 3
  const capSeconds = options.retryAfterCapSeconds ?? 30
  const sleep = options.sleep ?? realSleep

  let lastError: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const isLast = attempt === maxAttempts - 1
    try {
      const response = await gatedFetch(fetcher, url, options, init)
      if ((response.status === 429 || response.status >= 500) && !isLast) {
        await sleep(retryDelayMs(response, attempt, capSeconds))
        continue
      }
      return response
    } catch (error) {
      if (isLast || !isRetryableFetchError(error)) throw error
      lastError = error
      await sleep(backoffMs(attempt))
    }
  }
  throw lastError instanceof Error ? lastError : new Error("gatedFetchWithRetry exhausted")
}

export async function readJsonBody(
  response: Response,
  maxBytes = MAX_DEFAULT_BYTES,
): Promise<unknown> {
  const text = await response.text()
  if (Buffer.byteLength(text) > maxBytes) {
    throw new RangeError("Response body exceeds size limit")
  }
  const contentType = response.headers.get("content-type")
  if (!contentType?.toLowerCase().includes("application/json")) {
    throw new TypeError("Expected JSON response")
  }
  return JSON.parse(text) as unknown
}

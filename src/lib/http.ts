import type { FetchLike } from "../collectors/market/geckoterminal.js"
import { getRateGate } from "./rate-gate.js"

const MAX_DEFAULT_BYTES = 5 * 1024 * 1024

export type GatedFetchOptions = Readonly<{
  host: string
  capacity: number
  refillPerSecond: number
  monthlyBudget?: number
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
  })
  await gate.take()

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

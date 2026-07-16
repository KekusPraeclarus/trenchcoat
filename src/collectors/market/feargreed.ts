import { gatedFetch, readJsonBody } from "../../lib/http.js"
import type { FetchLike } from "../market/geckoterminal.js"

export async function fetchFearGreed(
  fetcher: FetchLike,
): Promise<{ value: number; timestamp: number; classification: string }> {
  const response = await gatedFetch(
    fetcher,
    "https://api.alternative.me/fng/?limit=1&format=json",
    {
      host: "api.alternative.me",
      capacity: 10,
      refillPerSecond: 0.1,
      timeoutMs: 10_000,
    },
  )
  if (!response.ok) throw new Error(`FearGreed HTTP ${response.status}`)
  const body = await readJsonBody(response) as {
    data?: Array<{ value: string; timestamp: string; value_classification: string }>
  }
  const row = body.data?.[0]
  if (!row) throw new Error("FearGreed empty")
  const timestamp = Number(row.timestamp) * 1000
  if (!Number.isFinite(timestamp)) throw new Error("FearGreed bad timestamp")
  if (Date.now() - timestamp > 48 * 3600_000) {
    throw new Error("FearGreed stale")
  }
  return {
    value: Number(row.value),
    timestamp,
    classification: row.value_classification,
  }
}

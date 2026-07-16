import { gatedFetch, readJsonBody } from "../../lib/http.js"
import type { FetchLike } from "../market/geckoterminal.js"

export type CastItem = Readonly<{
  hash: string
  text: string
  author: string
  timestamp: string
}>

export async function fetchGlobalFeed(
  fetcher: FetchLike,
  apiKey: string,
  cursor?: string,
): Promise<{ casts: CastItem[]; nextCursor?: string }> {
  const url = new URL("https://api.neynar.com/v2/farcaster/feed")
  url.searchParams.set("feed_type", "filter")
  url.searchParams.set("filter_type", "global_trending")
  url.searchParams.set("limit", "25")
  if (cursor) url.searchParams.set("cursor", cursor)
  const response = await gatedFetch(fetcher, url, {
    host: "api.neynar.com",
    capacity: 30,
    refillPerSecond: 0.5,
    headers: {
      accept: "application/json",
      api_key: apiKey,
    },
    timeoutMs: 15_000,
  })
  if (!response.ok) throw new Error(`Neynar HTTP ${response.status}`)
  const body = await readJsonBody(response) as {
    casts?: Array<{
      hash?: string
      text?: string
      author?: { username?: string }
      timestamp?: string
    }>
    next?: { cursor?: string }
  }
  const casts = (body.casts ?? []).map((c) => ({
    hash: String(c.hash ?? ""),
    text: String(c.text ?? ""),
    author: String(c.author?.username ?? ""),
    timestamp: String(c.timestamp ?? new Date().toISOString()),
  })).filter((c) => c.hash)
  return {
    casts,
    ...(body.next?.cursor ? { nextCursor: body.next.cursor } : {}),
  }
}

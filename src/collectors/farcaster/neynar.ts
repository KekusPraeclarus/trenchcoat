import { gatedFetch, readJsonBody } from "../../lib/http.js"
import type { FetchLike } from "../market/geckoterminal.js"

const NEYNAR_ROOT = "https://api.neynar.com"

export type FarcasterCast = Readonly<{
  hash: string
  author: string
  text: string
  timestamp: string
  url?: string
  provenance: string
}>

export type FarcasterFeed = Readonly<{ casts: readonly FarcasterCast[]; nextCursor?: string }>

export async function fetchNeynarFeed(
  fetcher: FetchLike,
  apiKey: string,
  kind: "trending" | "global" | "channel",
  cursor?: string,
  channelId?: string,
): Promise<FarcasterFeed> {
  if (!apiKey.trim()) throw new Error("Neynar API key is required")
  if (cursor !== undefined && !/^[A-Za-z0-9._=-]{1,512}$/u.test(cursor)) throw new TypeError("Invalid Neynar cursor")
  if (kind === "channel" && (!channelId || !/^[A-Za-z0-9-]{1,128}$/u.test(channelId))) throw new TypeError("A safe channel id is required")
  const path = kind === "trending"
    ? "/v2/farcaster/feed/trending"
    : kind === "global"
      ? "/v2/farcaster/feed"
      : "/v2/farcaster/feed/channel"
  const url = new URL(path, NEYNAR_ROOT)
  if (cursor) url.searchParams.set("cursor", cursor)
  if (channelId) url.searchParams.set("channel_id", channelId)
  const response = await gatedFetch(fetcher, url, {
    host: "api.neynar.com",
    capacity: 500,
    refillPerSecond: 500 / 60,
    headers: { "x-api-key": apiKey },
  })
  if (!response.ok) throw new Error(`Neynar request failed with HTTP ${response.status}`)
  const payload = await readJsonBody(response)
  if (payload === null || typeof payload !== "object") throw new TypeError("Neynar response must be an object")
  const casts = Reflect.get(payload, "casts")
  if (!Array.isArray(casts) || casts.length > 100) throw new TypeError("Neynar response has invalid casts")
  const next = Reflect.get(payload, "next")
  const nextCursor = next !== null && typeof next === "object" ? Reflect.get(next, "cursor") : undefined
  return {
    casts: casts.map((cast) => {
      if (cast === null || typeof cast !== "object") throw new TypeError("Neynar cast must be an object")
      const author = Reflect.get(cast, "author")
      const username = author !== null && typeof author === "object" ? Reflect.get(author, "username") : undefined
      const hash = Reflect.get(cast, "hash")
      const text = Reflect.get(cast, "text")
      const timestamp = Reflect.get(cast, "timestamp")
      const url = Reflect.get(cast, "url")
      if (typeof hash !== "string" || typeof username !== "string" || typeof text !== "string" || typeof timestamp !== "string") throw new TypeError("Neynar cast missing required fields")
      return { hash, author: username, text, timestamp, provenance: `farcaster:@${username}`, ...(typeof url === "string" ? { url } : {}) }
    }),
    ...(typeof nextCursor === "string" ? { nextCursor } : {}),
  }
}

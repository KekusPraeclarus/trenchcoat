import { gatedFetch, readJsonBody } from "../../lib/http.js"
import type { FetchLike } from "../market/geckoterminal.js"

export const NEYNAR_HOST = "api.neynar.com"
export const NEYNAR_ROOT = `https://${NEYNAR_HOST}`

const RATE = { capacity: 500, refillPerSecond: 500 / 60 } as const

export type FarcasterEngagement = Readonly<{
  likes?: number
  recasts?: number
  replies?: number
}>

export type FarcasterCast = Readonly<{
  hash: string
  author: string
  authorFid: number
  text: string
  timestamp: string
  url?: string
  provenance: string
  engagement: FarcasterEngagement
}>

export type FarcasterFeed = Readonly<{
  casts: readonly FarcasterCast[]
  nextCursor?: string
}>

export type NeynarFeedKind =
  | "for_you"
  | "following"
  | "trending"
  | "global"
  | "channel"

const CURSOR_RE = /^[A-Za-z0-9._=-]{1,512}$/u
const CHANNEL_RE = /^[A-Za-z0-9-]{1,128}$/u
const HASH_RE = /^0x[a-fA-F0-9]{40}$/u
const USERNAME_RE = /^[a-z0-9][a-z0-9-]{0,15}$/u

function requireApiKey(apiKey: string): string {
  const key = apiKey.trim()
  if (!key) throw new Error("Neynar API key is required")
  return key
}

function assertCursor(cursor: string | undefined): void {
  if (cursor !== undefined && !CURSOR_RE.test(cursor)) {
    throw new TypeError("Invalid Neynar cursor")
  }
}

function assertFid(fid: number | undefined, label: string): number {
  if (fid === undefined || !Number.isInteger(fid) || fid < 1) {
    throw new TypeError(`${label} must be a positive integer FID`)
  }
  return fid
}

function optionalCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined
  return Math.floor(value)
}

export function parseNeynarCast(raw: unknown): FarcasterCast {
  if (raw === null || typeof raw !== "object") throw new TypeError("Neynar cast must be an object")
  const author = Reflect.get(raw, "author")
  if (author === null || typeof author !== "object") throw new TypeError("Neynar cast missing author")
  const usernameRaw = Reflect.get(author, "username")
  const fidRaw = Reflect.get(author, "fid")
  const hash = Reflect.get(raw, "hash")
  const text = Reflect.get(raw, "text")
  const timestamp = Reflect.get(raw, "timestamp")
  const url = Reflect.get(raw, "url")
  if (typeof hash !== "string" || !HASH_RE.test(hash)) throw new TypeError("Neynar cast missing hash")
  if (typeof usernameRaw !== "string" || !USERNAME_RE.test(usernameRaw.toLowerCase())) {
    throw new TypeError("Neynar cast missing username")
  }
  if (typeof fidRaw !== "number" || !Number.isInteger(fidRaw) || fidRaw < 1) {
    throw new TypeError("Neynar cast missing author fid")
  }
  if (typeof text !== "string") throw new TypeError("Neynar cast missing text")
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
    throw new TypeError("Neynar cast missing timestamp")
  }
  const username = usernameRaw.toLowerCase()
  const reactions = Reflect.get(raw, "reactions")
  const replies = Reflect.get(raw, "replies")
  const likes = reactions !== null && typeof reactions === "object"
    ? optionalCount(Reflect.get(reactions, "likes_count"))
    : undefined
  const recasts = reactions !== null && typeof reactions === "object"
    ? optionalCount(Reflect.get(reactions, "recasts_count"))
    : undefined
  const replyCount = replies !== null && typeof replies === "object"
    ? optionalCount(Reflect.get(replies, "count"))
    : undefined
  return {
    hash,
    author: username,
    authorFid: fidRaw,
    text,
    timestamp,
    provenance: `farcaster:@${username}`,
    engagement: {
      ...(likes !== undefined ? { likes } : {}),
      ...(recasts !== undefined ? { recasts } : {}),
      ...(replyCount !== undefined ? { replies: replyCount } : {}),
    },
    ...(typeof url === "string" ? { url } : {}),
  }
}

function parseFeedPayload(payload: unknown): FarcasterFeed {
  if (payload === null || typeof payload !== "object") {
    throw new TypeError("Neynar response must be an object")
  }
  const casts = Reflect.get(payload, "casts")
  if (!Array.isArray(casts) || casts.length > 100) {
    throw new TypeError("Neynar response has invalid casts")
  }
  const next = Reflect.get(payload, "next")
  const nextCursor = next !== null && typeof next === "object"
    ? Reflect.get(next, "cursor")
    : undefined
  return {
    casts: casts.flatMap((raw) => {
      try {
        return [parseNeynarCast(raw)]
      } catch {
        return []
      }
    }),
    ...(typeof nextCursor === "string" ? { nextCursor } : {}),
  }
}

async function neynarGet(
  fetcher: FetchLike,
  apiKey: string,
  path: string,
  query: Record<string, string>,
): Promise<unknown> {
  const url = new URL(path, NEYNAR_ROOT)
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value)
  }
  const response = await gatedFetch(fetcher, url, {
    host: NEYNAR_HOST,
    ...RATE,
    headers: {
      accept: "application/json",
      "x-api-key": apiKey,
    },
  })
  if (!response.ok) throw new Error(`Neynar request failed with HTTP ${response.status}`)
  return readJsonBody(response)
}

export async function fetchNeynarFeed(
  fetcher: FetchLike,
  apiKey: string,
  kind: NeynarFeedKind,
  opts: Readonly<{
    cursor?: string
    channelId?: string
    fid?: number
    limit?: number
  }> = {},
): Promise<FarcasterFeed> {
  const key = requireApiKey(apiKey)
  assertCursor(opts.cursor)
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 50)
  const query: Record<string, string> = { limit: String(limit) }
  if (opts.cursor) query["cursor"] = opts.cursor

  let path: string
  if (kind === "for_you") {
    const fid = assertFid(opts.fid, "for_you fid")
    path = "/v2/farcaster/feed/for_you"
    query["fid"] = String(fid)
  } else if (kind === "following") {
    const fid = assertFid(opts.fid, "following fid")
    path = "/v2/farcaster/feed"
    query["feed_type"] = "following"
    query["fid"] = String(fid)
  } else if (kind === "trending") {
    path = "/v2/farcaster/feed/trending"
  } else if (kind === "global") {
    path = "/v2/farcaster/feed"
    query["feed_type"] = "filter"
    query["filter_type"] = "global_trending"
  } else {
    if (!opts.channelId || !CHANNEL_RE.test(opts.channelId)) {
      throw new TypeError("A safe channel id is required")
    }
    path = "/v2/farcaster/feed/channel"
    query["channel_id"] = opts.channelId
  }

  return parseFeedPayload(await neynarGet(fetcher, key, path, query))
}

export async function searchCasts(
  fetcher: FetchLike,
  apiKey: string,
  query: string,
  opts: Readonly<{ cursor?: string, limit?: number }> = {},
): Promise<FarcasterFeed> {
  const key = requireApiKey(apiKey)
  const q = query.trim()
  if (!q || q.length > 256) throw new TypeError("Cast search query must be 1..256 chars")
  assertCursor(opts.cursor)
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100)
  const params: Record<string, string> = {
    q,
    limit: String(limit),
  }
  if (opts.cursor) params["cursor"] = opts.cursor
  return parseFeedPayload(
    await neynarGet(fetcher, key, "/v2/farcaster/cast/search", params),
  )
}

export async function fetchUserByUsername(
  fetcher: FetchLike,
  apiKey: string,
  username: string,
): Promise<Readonly<{ fid: number, username: string }>> {
  const key = requireApiKey(apiKey)
  const handle = username.replace(/^@/u, "").toLowerCase()
  if (!USERNAME_RE.test(handle)) throw new TypeError("Invalid Farcaster username")
  const payload = await neynarGet(fetcher, key, "/v2/farcaster/user/by_username", {
    username: handle,
  })
  if (payload === null || typeof payload !== "object") {
    throw new TypeError("Neynar user response must be an object")
  }
  const user = Reflect.get(payload, "user")
  if (user === null || typeof user !== "object") throw new TypeError("Neynar user missing")
  const fid = Reflect.get(user, "fid")
  const uname = Reflect.get(user, "username")
  if (typeof fid !== "number" || !Number.isInteger(fid) || fid < 1) {
    throw new TypeError("Neynar user missing fid")
  }
  if (typeof uname !== "string") throw new TypeError("Neynar user missing username")
  return { fid, username: uname.toLowerCase() }
}

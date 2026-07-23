import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFile } from "../../lib/fs-atomic.js"
import type { TxEvent } from "./types.js"

export type DiscordWalletObservationCache = Readonly<{
  schema: 1
  updatedAt: string
  events: readonly TxEvent[]
}>

const MAX_EVENTS = 2_000
const RETAIN_MS = 24 * 3_600_000

function cachePath(archiveRoot: string): string {
  return join(archiveRoot, "provider-observations", "discord-wallet", "latest.json")
}

export function emptyObservationCache(updatedAt: string): DiscordWalletObservationCache {
  return { schema: 1, updatedAt, events: [] }
}

export function loadObservationCache(
  archiveRoot: string,
): DiscordWalletObservationCache | undefined {
  const path = cachePath(archiveRoot)
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as DiscordWalletObservationCache
    if (raw.schema !== 1 || !Array.isArray(raw.events)) return undefined
    return raw
  } catch {
    return undefined
  }
}

export function pruneObservationCache(
  cache: DiscordWalletObservationCache,
  nowIso: string,
): DiscordWalletObservationCache {
  const nowMs = Date.parse(nowIso)
  const events = cache.events.filter((event) => {
    const ts = Date.parse(event.receivedAt)
    if (!Number.isFinite(ts)) return false
    return nowMs - ts <= RETAIN_MS
  }).slice(-MAX_EVENTS)
  return { schema: 1, updatedAt: nowIso, events }
}

export async function saveObservationCache(
  archiveRoot: string,
  cache: DiscordWalletObservationCache,
): Promise<void> {
  const pruned = pruneObservationCache(cache, cache.updatedAt)
  await writeAtomicFile(cachePath(archiveRoot), `${JSON.stringify(pruned, null, 2)}\n`)
}

export function mergeObservations(
  cache: DiscordWalletObservationCache,
  next: readonly TxEvent[],
  nowIso: string,
): DiscordWalletObservationCache {
  const seen = new Set(cache.events.map((event) => `${event.channelId}:${event.messageId}`))
  const appended = next.filter((event) => {
    const key = `${event.channelId}:${event.messageId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return pruneObservationCache({
    schema: 1,
    updatedAt: nowIso,
    events: [...cache.events, ...appended],
  }, nowIso)
}

export function liveTokenEvents(
  cache: DiscordWalletObservationCache,
  chain: string,
  token: string,
  nowIso: string,
): readonly TxEvent[] {
  const nowMs = Date.parse(nowIso)
  const tokenLower = token.toLowerCase()
  return cache.events.filter((event) => {
    if (!event.tokenContract) return false
    if (event.tokenContract.toLowerCase() !== tokenLower) return false
    if (event.chain && event.chain.toLowerCase() !== chain.toLowerCase()) return false
    const ts = Date.parse(event.receivedAt)
    if (!Number.isFinite(ts)) return false
    return nowMs - ts <= RETAIN_MS
  })
}

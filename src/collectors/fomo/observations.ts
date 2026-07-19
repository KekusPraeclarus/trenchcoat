import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFile } from "../../lib/fs-atomic.js"
import type {
  FomoAlertEvent,
  FomoDerivedSignal,
  FomoLeaderboardEntry,
  FomoThesis,
  FomoTradeEvent,
  FomoTrendingObservation,
} from "./types.js"
import { LIVE_SEC } from "./freshness.js"

export type FomoObservation =
  | Readonly<{ kind: "leaderboard", record: FomoLeaderboardEntry }>
  | Readonly<{ kind: "trade", record: FomoTradeEvent }>
  | Readonly<{ kind: "trending", record: FomoTrendingObservation }>
  | Readonly<{ kind: "alert", record: FomoAlertEvent }>
  | Readonly<{ kind: "thesis", record: FomoThesis }>
  | Readonly<{ kind: "signal", record: FomoDerivedSignal }>

export type FomoObservationCache = Readonly<{
  schema: 1
  updatedAt: string
  items: readonly FomoObservation[]
}>

const MAX_ITEMS = 500
const RETAIN_SEC = 24 * 3_600

function cachePath(archiveRoot: string): string {
  return join(archiveRoot, "provider-observations", "fomo", "latest.json")
}

export function observationEventTime(item: FomoObservation): string {
  switch (item.kind) {
    case "leaderboard":
    case "trending":
      return item.record.observedAt
    case "trade":
    case "alert":
    case "thesis":
      return item.record.eventAt
    case "signal":
      return item.record.observedAt
  }
}

export function emptyObservationCache(updatedAt: string): FomoObservationCache {
  return { schema: 1, updatedAt, items: [] }
}

export function loadObservationCache(archiveRoot: string): FomoObservationCache | undefined {
  const path = cachePath(archiveRoot)
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as FomoObservationCache
    if (raw.schema !== 1 || !Array.isArray(raw.items)) return undefined
    return raw
  } catch {
    return undefined
  }
}

export function pruneObservationCache(
  cache: FomoObservationCache,
  nowIso: string,
): FomoObservationCache {
  const nowMs = Date.parse(nowIso)
  const items = cache.items.filter((item) => {
    const ts = Date.parse(observationEventTime(item))
    if (!Number.isFinite(ts)) return false
    return Math.floor((nowMs - ts) / 1_000) <= RETAIN_SEC
  }).slice(-MAX_ITEMS)
  return { schema: 1, updatedAt: nowIso, items }
}

export async function saveObservationCache(
  archiveRoot: string,
  cache: FomoObservationCache,
): Promise<void> {
  const pruned = pruneObservationCache(cache, cache.updatedAt)
  await writeAtomicFile(cachePath(archiveRoot), `${JSON.stringify(pruned, null, 2)}\n`)
}

export function mergeObservations(
  cache: FomoObservationCache,
  next: readonly FomoObservation[],
  nowIso: string,
): FomoObservationCache {
  return pruneObservationCache({
    schema: 1,
    updatedAt: nowIso,
    items: [...cache.items, ...next],
  }, nowIso)
}

export function liveTokenContext(
  cache: FomoObservationCache,
  chain: string,
  tokenAddress: string,
  nowIso: string,
): FomoObservation[] {
  const nowMs = Date.parse(nowIso)
  return cache.items.filter((item) => {
    const record = item.record as { chain?: string, tokenAddress?: string }
    if (record.chain !== chain || record.tokenAddress !== tokenAddress) return false
    const ageSec = Math.max(0, Math.floor((nowMs - Date.parse(observationEventTime(item))) / 1_000))
    return ageSec <= LIVE_SEC
  })
}

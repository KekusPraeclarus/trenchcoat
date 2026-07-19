import { existsSync, readFileSync } from "node:fs"
import { discordLayout } from "./paths.js"
import { createDiscordStore } from "./store.js"
import { pruneExpiredWatchlist, countActiveTokens } from "./watchlist.js"
import { DiscordHeartbeatSchema } from "./schemas.js"

export type DiscordStatusSnapshot = Readonly<{
  enabled: boolean
  listenerHeartbeatAgeSec?: number
  queueDepth: number
  running: number
  watchedTokens: number
  subscribers: number
  monitorHeartbeatAgeSec?: number
  lastListenerError?: string
  lastMonitorError?: string
}>

function heartbeatAgeSec(path: string, nowMs: number): number | undefined {
  if (!existsSync(path)) return undefined
  try {
    const beat = DiscordHeartbeatSchema.parse(JSON.parse(readFileSync(path, "utf8")))
    return Math.max(0, Math.floor((nowMs - Date.parse(beat.updatedAt)) / 1_000))
  } catch {
    return undefined
  }
}

export function loadDiscordStatus(nowIso = new Date().toISOString()): DiscordStatusSnapshot {
  const layout = discordLayout()
  const store = createDiscordStore(layout)
  const requests = store.loadRequests()
  const watch = pruneExpiredWatchlist(store.loadWatchlist(), nowIso)
  const nowMs = Date.parse(nowIso)

  let subscribers = 0
  for (const token of watch.tokens) {
    subscribers += token.subscriptions.length
  }

  let lastListenerError: string | undefined
  let lastMonitorError: string | undefined
  if (existsSync(layout.listenerHeartbeat)) {
    try {
      const beat = DiscordHeartbeatSchema.parse(JSON.parse(readFileSync(layout.listenerHeartbeat, "utf8")))
      lastListenerError = beat.lastError
    } catch { /* ignore */ }
  }
  if (existsSync(layout.monitorHeartbeat)) {
    try {
      const beat = DiscordHeartbeatSchema.parse(JSON.parse(readFileSync(layout.monitorHeartbeat, "utf8")))
      lastMonitorError = beat.lastError
    } catch { /* ignore */ }
  }

  return {
    enabled: true,
    queueDepth: requests.requests.filter((r) => r.status === "queued").length,
    running: requests.requests.filter((r) => r.status === "running").length,
    watchedTokens: countActiveTokens(watch, nowIso),
    subscribers,
    ...(heartbeatAgeSec(layout.listenerHeartbeat, nowMs) !== undefined
      ? { listenerHeartbeatAgeSec: heartbeatAgeSec(layout.listenerHeartbeat, nowMs)! }
      : {}),
    ...(heartbeatAgeSec(layout.monitorHeartbeat, nowMs) !== undefined
      ? { monitorHeartbeatAgeSec: heartbeatAgeSec(layout.monitorHeartbeat, nowMs)! }
      : {}),
    ...(lastListenerError ? { lastListenerError } : {}),
    ...(lastMonitorError ? { lastMonitorError } : {}),
  }
}

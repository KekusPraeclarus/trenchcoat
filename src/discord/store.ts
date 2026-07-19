import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { writeAtomicFileFsync } from "../lib/fs-atomic.js"
import type { DiscordLayout } from "./paths.js"
import {
  DiscordDeliveriesFileSchema,
  DiscordHeartbeatSchema,
  DiscordMonitorCursorSchema,
  DiscordObservationsFileSchema,
  DiscordRequestsFileSchema,
  DiscordWatchlistFileSchema,
  type DiscordDeliveriesFile,
  type DiscordHeartbeat,
  type DiscordMonitorCursor,
  type DiscordObservationsFile,
  type DiscordRequestsFile,
  type DiscordWatchlistFile,
} from "./schemas.js"

const MAX_FILE_BYTES = 4_000_000

function utcDayKey(iso: string): string {
  return iso.slice(0, 10)
}

function ensureRoot(layout: DiscordLayout): void {
  mkdirSync(layout.root, { recursive: true, mode: 0o700 })
}

function readBounded(path: string): unknown {
  if (!existsSync(path)) return undefined
  const raw = readFileSync(path, "utf8")
  if (raw.length > MAX_FILE_BYTES) {
    throw new Error(`discord state file too large: ${path}`)
  }
  return JSON.parse(raw)
}

function quarantine(layout: DiscordLayout, name: string, raw: string): never {
  ensureRoot(layout)
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-")
  const dest = `${layout.root}/${name}.quarantine.${stamp}.json`
  writeFileSync(dest, raw, { mode: 0o600 })
  throw new Error(`discord state quarantined: ${name}`)
}

function loadFile<T>(
  layout: DiscordLayout,
  path: string,
  name: string,
  schema: { parse: (v: unknown) => T },
  empty: () => T,
): T {
  ensureRoot(layout)
  if (!existsSync(path)) return empty()
  let raw = ""
  try {
    raw = readFileSync(path, "utf8")
    if (raw.length > MAX_FILE_BYTES) throw new Error("too large")
    const parsed = schema.parse(JSON.parse(raw))
    return parsed
  } catch (error) {
    if (raw) quarantine(layout, name, raw)
    throw error
  }
}

async function saveFile(path: string, value: unknown): Promise<void> {
  await writeAtomicFileFsync(path, `${JSON.stringify(value, null, 2)}\n`, 0o600)
}

export function emptyRequestsFile(nowIso: string): DiscordRequestsFile {
  const day = utcDayKey(nowIso)
  return { schema: 1, requests: [], dailyByUser: {}, dailyServer: 0, quotaDay: day }
}

export function emptyWatchlistFile(): DiscordWatchlistFile {
  return { schema: 1, tokens: [] }
}

export function emptyObservationsFile(): DiscordObservationsFile {
  return { schema: 1, byToken: {} }
}

export function emptyDeliveriesFile(): DiscordDeliveriesFile {
  return { schema: 1, deliveries: [] }
}

export type DiscordStore = Readonly<{
  layout: DiscordLayout
  loadRequests(): DiscordRequestsFile
  saveRequests(file: DiscordRequestsFile): Promise<void>
  loadWatchlist(): DiscordWatchlistFile
  saveWatchlist(file: DiscordWatchlistFile): Promise<void>
  loadObservations(): DiscordObservationsFile
  saveObservations(file: DiscordObservationsFile): Promise<void>
  loadDeliveries(): DiscordDeliveriesFile
  saveDeliveries(file: DiscordDeliveriesFile): Promise<void>
  writeHeartbeat(kind: "listener" | "monitor", beat: DiscordHeartbeat): Promise<void>
  loadMonitorCursor(): DiscordMonitorCursor | undefined
  saveMonitorCursor(cursor: DiscordMonitorCursor | null): Promise<void>
}>

export function createDiscordStore(layout: DiscordLayout): DiscordStore {
  return {
    layout,
    loadRequests() {
      return loadFile(
        layout,
        layout.requests,
        "requests",
        DiscordRequestsFileSchema,
        () => emptyRequestsFile(new Date().toISOString()),
      )
    },
    async saveRequests(file) {
      DiscordRequestsFileSchema.parse(file)
      await saveFile(layout.requests, file)
    },
    loadWatchlist() {
      return loadFile(
        layout,
        layout.watchlist,
        "watchlist",
        DiscordWatchlistFileSchema,
        emptyWatchlistFile,
      )
    },
    async saveWatchlist(file) {
      DiscordWatchlistFileSchema.parse(file)
      await saveFile(layout.watchlist, file)
    },
    loadObservations() {
      return loadFile(
        layout,
        layout.observations,
        "observations",
        DiscordObservationsFileSchema,
        emptyObservationsFile,
      )
    },
    async saveObservations(file) {
      DiscordObservationsFileSchema.parse(file)
      await saveFile(layout.observations, file)
    },
    loadDeliveries() {
      return loadFile(
        layout,
        layout.deliveries,
        "deliveries",
        DiscordDeliveriesFileSchema,
        emptyDeliveriesFile,
      )
    },
    async saveDeliveries(file) {
      DiscordDeliveriesFileSchema.parse(file)
      await saveFile(layout.deliveries, file)
    },
    async writeHeartbeat(kind, beat) {
      DiscordHeartbeatSchema.parse(beat)
      const path = kind === "listener" ? layout.listenerHeartbeat : layout.monitorHeartbeat
      await saveFile(path, beat)
    },
    loadMonitorCursor() {
      if (!existsSync(layout.monitorCursor)) return undefined
      const raw = readFileSync(layout.monitorCursor, "utf8")
      return DiscordMonitorCursorSchema.parse(JSON.parse(raw))
    },
    async saveMonitorCursor(cursor) {
      if (cursor === null) {
        if (existsSync(layout.monitorCursor)) {
          const tmp = `${layout.monitorCursor}.delete.${Date.now()}`
          renameSync(layout.monitorCursor, tmp)
        }
        return
      }
      DiscordMonitorCursorSchema.parse(cursor)
      await saveFile(layout.monitorCursor, cursor)
    },
  }
}

export function rolloverQuotaDay(
  file: DiscordRequestsFile,
  nowIso: string,
): DiscordRequestsFile {
  const day = utcDayKey(nowIso)
  if (file.quotaDay === day) return file
  return { ...file, quotaDay: day, dailyByUser: {}, dailyServer: 0 }
}

export function pruneOldRequests(
  file: DiscordRequestsFile,
  nowIso: string,
  retainDays = 35,
): DiscordRequestsFile {
  const cutoff = Date.parse(nowIso) - retainDays * 86_400_000
  const requests = file.requests.filter((r) => Date.parse(r.createdAt) >= cutoff)
  return requests.length === file.requests.length ? file : { ...file, requests }
}

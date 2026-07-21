import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFileFsync } from "../lib/fs-atomic.js"
import type { RemediationLayout } from "./paths.js"
import {
  DeferredQueueFileSchema,
  RemediationCursorsFileSchema,
  RemediationIncidentSchema,
  RemediationsFileSchema,
  SourceHealthLedgerSchema,
  type DeferredQueueFile,
  type RemediationCursorsFile,
  type RemediationIncident,
  type RemediationsFile,
  type SourceHealthLedger,
} from "./schemas.js"
import { emptySourceHealthLedger } from "./source-health.js"

const MAX_FILE_BYTES = 4_000_000

function ensureRoot(layout: RemediationLayout): void {
  mkdirSync(layout.root, { recursive: true, mode: 0o700 })
  mkdirSync(layout.artifacts, { recursive: true, mode: 0o700 })
  mkdirSync(layout.journal, { recursive: true, mode: 0o700 })
}

function quarantine(layout: RemediationLayout, name: string, raw: string): never {
  ensureRoot(layout)
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-")
  const dest = join(layout.root, `${name}.quarantine.${stamp}.json`)
  writeFileSync(dest, raw, { mode: 0o600 })
  throw new Error(`remediation state quarantined: ${name}`)
}

export function emptyRemediationsFile(): RemediationsFile {
  return {
    schema: 1,
    incidents: [],
    attemptsByDay: {},
    activeIncidentId: null,
    automationHalted: false,
  }
}

export function emptyCursorsFile(): RemediationCursorsFile {
  return {
    schema: 1,
    logs: [],
    lastSkipOffsets: {},
  }
}

export function emptyDeferredFile(): DeferredQueueFile {
  return {
    schema: 1,
    incidentIds: [],
  }
}

export type RemediationStore = Readonly<{
  layout: RemediationLayout
  load(): RemediationsFile
  save(file: RemediationsFile): Promise<void>
  loadCursors(): RemediationCursorsFile
  saveCursors(file: RemediationCursorsFile): Promise<void>
  loadDeferred(): DeferredQueueFile
  saveDeferred(file: DeferredQueueFile): Promise<void>
  loadSourceHealthLedger(): SourceHealthLedger
  saveSourceHealthLedger(file: SourceHealthLedger): Promise<void>
  findById(id: string): RemediationIncident | undefined
  findByFingerprint(fingerprint: string, activeOnly?: boolean): RemediationIncident | undefined
}>

export function createRemediationStore(
  layout: RemediationLayout,
): RemediationStore {
  return {
    layout,
    load() {
      ensureRoot(layout)
      if (!existsSync(layout.index)) return emptyRemediationsFile()
      let raw = ""
      try {
        raw = readFileSync(layout.index, "utf8")
        if (raw.length > MAX_FILE_BYTES) throw new Error("too large")
        return RemediationsFileSchema.parse(JSON.parse(raw))
      } catch (error) {
        if (raw) quarantine(layout, "index", raw)
        throw error
      }
    },
    async save(file) {
      ensureRoot(layout)
      RemediationsFileSchema.parse(file)
      await writeAtomicFileFsync(
        layout.index,
        `${JSON.stringify(file, null, 2)}\n`,
        0o600,
      )
    },
    loadCursors() {
      ensureRoot(layout)
      if (!existsSync(layout.cursors)) return emptyCursorsFile()
      let raw = ""
      try {
        raw = readFileSync(layout.cursors, "utf8")
        if (raw.length > MAX_FILE_BYTES) throw new Error("too large")
        return RemediationCursorsFileSchema.parse(JSON.parse(raw))
      } catch (error) {
        if (raw) quarantine(layout, "cursors", raw)
        throw error
      }
    },
    async saveCursors(file) {
      ensureRoot(layout)
      RemediationCursorsFileSchema.parse(file)
      await writeAtomicFileFsync(
        layout.cursors,
        `${JSON.stringify(file, null, 2)}\n`,
        0o600,
      )
    },
    loadDeferred() {
      ensureRoot(layout)
      if (!existsSync(layout.deferred)) return emptyDeferredFile()
      let raw = ""
      try {
        raw = readFileSync(layout.deferred, "utf8")
        if (raw.length > MAX_FILE_BYTES) throw new Error("too large")
        return DeferredQueueFileSchema.parse(JSON.parse(raw))
      } catch (error) {
        if (raw) quarantine(layout, "deferred", raw)
        throw error
      }
    },
    async saveDeferred(file) {
      ensureRoot(layout)
      DeferredQueueFileSchema.parse(file)
      await writeAtomicFileFsync(
        layout.deferred,
        `${JSON.stringify(file, null, 2)}\n`,
        0o600,
      )
    },
    loadSourceHealthLedger() {
      ensureRoot(layout)
      if (!existsSync(layout.sourceHealthLedger)) return emptySourceHealthLedger()
      let raw = ""
      try {
        raw = readFileSync(layout.sourceHealthLedger, "utf8")
        if (raw.length > MAX_FILE_BYTES) throw new Error("too large")
        return SourceHealthLedgerSchema.parse(JSON.parse(raw))
      } catch (error) {
        if (raw) quarantine(layout, "source-health-ledger", raw)
        throw error
      }
    },
    async saveSourceHealthLedger(file) {
      ensureRoot(layout)
      SourceHealthLedgerSchema.parse(file)
      await writeAtomicFileFsync(
        layout.sourceHealthLedger,
        `${JSON.stringify(file, null, 2)}\n`,
        0o600,
      )
    },
    findById(id) {
      return this.load().incidents.find((i) => i.incidentId === id)
    },
    findByFingerprint(fingerprint, activeOnly = true) {
      return this.load().incidents.find((i) => {
        if (i.fingerprint !== fingerprint) return false
        if (!activeOnly) return true
        return i.phase !== "completed"
          && i.phase !== "failed"
          && i.phase !== "ignored"
          && i.phase !== "rejected"
          && i.phase !== "rolled-back"
          && i.phase !== "attention-required"
      })
    },
  }
}

export async function appendRemediationJournal(
  layout: RemediationLayout,
  incidentId: string,
  event: Readonly<Record<string, unknown>>,
): Promise<void> {
  ensureRoot(layout)
  const path = join(layout.journal, `${incidentId}.jsonl`)
  const line = `${JSON.stringify({ ...event, ts: new Date().toISOString() })}\n`
  const prev = existsSync(path) ? readFileSync(path, "utf8") : ""
  await writeAtomicFileFsync(path, `${prev}${line}`, 0o600)
}

export function upsertIncident(
  file: RemediationsFile,
  incident: RemediationIncident,
): RemediationsFile {
  RemediationIncidentSchema.parse(incident)
  const others = file.incidents.filter((i) => i.incidentId !== incident.incidentId)
  return {
    ...file,
    incidents: [incident, ...others].slice(0, 500),
  }
}

export function utcDayKey(nowIso: string): string {
  return nowIso.slice(0, 10)
}

export function attemptsToday(file: RemediationsFile, nowIso: string): number {
  return file.attemptsByDay[utcDayKey(nowIso)] ?? 0
}

export function bumpAttempts(
  file: RemediationsFile,
  nowIso: string,
): RemediationsFile {
  const day = utcDayKey(nowIso)
  return {
    ...file,
    attemptsByDay: {
      ...file.attemptsByDay,
      [day]: (file.attemptsByDay[day] ?? 0) + 1,
    },
  }
}

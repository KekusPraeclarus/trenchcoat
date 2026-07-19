import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  transactionJournalPath,
  writeJsonRecordFsync,
  type ArchiveLayout,
} from "../lib/archive.js"
import type { JsonValue } from "../lib/canonical-json.js"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { assertRunId } from "../lib/run-id.js"
import type { JournalStore } from "../contracts/interfaces.js"
import { RUN_PHASES, type RunJournal, type RunPhase, type RunStatus } from "./journal.js"

export type JournalParseMode = "strict" | "scan"

export type JournalParseResult =
  | Readonly<{ ok: true; journal: RunJournal; legacyStatus: boolean }>
  | Readonly<{ ok: false; reason: string }>

function isRunPhase(value: unknown): value is RunPhase {
  return typeof value === "string" && (RUN_PHASES as readonly string[]).includes(value)
}

function isRunStatus(value: unknown): value is RunStatus {
  return value === "complete" || value === "failed" || value === "running"
}

/** Derive status for pre-ADR-006 journals that only stored phase */
export function deriveLegacyJournalStatus(args: Readonly<{
  phase: RunPhase
  status?: unknown
  failure?: unknown
}>): Readonly<{ status: RunStatus; legacyStatus: boolean }> {
  if (isRunStatus(args.status)) {
    return { status: args.status, legacyStatus: false }
  }
  if (args.status !== undefined) {
    throw new TypeError(`Journal status is invalid: ${String(args.status)}`)
  }
  if (args.phase === "complete") {
    return { status: "complete", legacyStatus: true }
  }
  if (args.failure !== undefined) {
    return { status: "failed", legacyStatus: true }
  }
  return { status: "running", legacyStatus: true }
}

/**
 * Canonical journal parse. Bulk archive scans use mode "scan" so one corrupt
 * file cannot abort narrative/review; direct load/resume stay strict.
 */
export function tryParseJournal(
  raw: unknown,
  mode: JournalParseMode = "strict",
): JournalParseResult {
  try {
    if (typeof raw !== "object" || raw === null) {
      throw new TypeError("Journal is not an object")
    }
    const candidate = raw as Record<string, unknown>
    const schema = candidate["schema"]
    if (schema !== undefined && schema !== 1) {
      throw new TypeError(`Journal schema is invalid: ${String(schema)}`)
    }
    assertRunId(String(candidate["runId"]))
    if (!isRunPhase(candidate["phase"])) {
      throw new TypeError("Journal phase is invalid")
    }
    const phase = candidate["phase"]
    const derived = deriveLegacyJournalStatus({
      phase,
      status: candidate["status"],
      failure: candidate["failure"],
    })
    if (phase === "complete" && derived.status !== "complete") {
      throw new TypeError("Journal phase complete requires status complete")
    }
    const journal: RunJournal = {
      ...(raw as RunJournal),
      schema: 1,
      status: derived.status,
    }
    return { ok: true, journal, legacyStatus: derived.legacyStatus }
  } catch (error) {
    if (mode === "strict") throw error
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

function parseJournal(raw: unknown): RunJournal {
  const parsed = tryParseJournal(raw, "strict")
  if (!parsed.ok) throw new TypeError(parsed.reason)
  return parsed.journal
}

/** Soft-load for bulk scans: corrupt journals return undefined instead of throwing */
export async function loadJournalForScan(
  layout: ArchiveLayout,
  runId: string,
): Promise<RunJournal | undefined> {
  assertRunId(runId)
  const path = transactionJournalPath(layout, runId)
  if (!existsSync(path)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
  const parsed = tryParseJournal(raw, "scan")
  return parsed.ok ? parsed.journal : undefined
}

// Archive is authoritative; the agent mirror is diagnostic and never read back
export function createJournalStore(layout: ArchiveLayout): JournalStore {
  return Object.freeze({
    async load(runId: string): Promise<RunJournal | undefined> {
      assertRunId(runId)
      const path = transactionJournalPath(layout, runId)
      if (!existsSync(path)) return undefined
      return parseJournal(JSON.parse(readFileSync(path, "utf8")))
    },

    async save(journal: RunJournal): Promise<void> {
      assertRunId(journal.runId)
      await writeJsonRecordFsync(
        transactionJournalPath(layout, journal.runId),
        journal as unknown as JsonValue,
      )
    },

    async mirrorToAgent(agentRoot: string, journal: RunJournal): Promise<void> {
      assertRunId(journal.runId)
      const path = join(agentRoot, "reports", journal.runId, "journal.json")
      await writeAtomicFile(path, `${JSON.stringify(journal, null, 2)}\n`)
    },
  })
}

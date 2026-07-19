import { existsSync, readFileSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import type { ArchiveLayout } from "../lib/archive.js"
import { assertRunId } from "../lib/run-id.js"
import type { ResumeApi } from "../contracts/interfaces.js"
import { type RunJournal, type RunPhase, RUN_PHASES } from "./journal.js"
import { tryParseJournal } from "./journal-store.js"
import { isQuarantined } from "./quarantine.js"

/** Journals stuck at phase=created longer than this are abandoned, not auto-resumed */
export const ABANDONED_CREATED_MS = 6 * 3_600_000

export type IncompleteRunRef = Readonly<{
  runId: string
  status: "running" | "abandoned"
  phase: RunPhase
  ageMs?: number
}>

export function nextPhase(journal: RunJournal): RunPhase | undefined {
  const index = RUN_PHASES.indexOf(journal.phase)
  if (index < 0) return undefined
  return RUN_PHASES[index + 1]
}

function runIdFromTransactionName(file: string): string | undefined {
  if (!file.endsWith(".json")) return undefined
  const runId = file.slice(0, -".json".length)
  try {
    assertRunId(runId)
    return runId
  } catch {
    return undefined
  }
}

function ageFromRunId(runId: string, nowMs: number): number | undefined {
  const match = runId.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/u)
  if (!match?.[1]) return undefined
  const iso = match[1].replace(
    /T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/u,
    "T$1:$2:$3.$4Z",
  )
  const created = Date.parse(iso)
  if (!Number.isFinite(created)) return undefined
  return Math.max(0, nowMs - created)
}

/**
 * Incomplete = normalized status still running, not quarantined.
 * Legacy phase=created journals older than ABANDONED_CREATED_MS are reported
 * as abandoned and never auto-resumed.
 */
export async function findIncompleteRunRefs(
  layout: ArchiveLayout,
  nowIso = new Date().toISOString(),
): Promise<IncompleteRunRef[]> {
  if (!existsSync(layout.transactions)) return []
  const files = await readdir(layout.transactions)
  const nowMs = Date.parse(nowIso)
  const incomplete: IncompleteRunRef[] = []
  for (const file of files) {
    const runId = runIdFromTransactionName(file)
    if (!runId) continue
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(join(layout.transactions, file), "utf8"))
    } catch {
      continue
    }
    const parsed = tryParseJournal(raw, "scan")
    if (!parsed.ok) continue
    const journal = parsed.journal
    if (journal.status === "complete" || journal.status === "failed") continue
    if (isQuarantined(layout, runId)) continue

    const ageMs = ageFromRunId(runId, nowMs)
    const abandoned = journal.phase === "created"
      && ageMs !== undefined
      && ageMs >= ABANDONED_CREATED_MS
    incomplete.push({
      runId,
      status: abandoned ? "abandoned" : "running",
      phase: journal.phase,
      ...(ageMs !== undefined ? { ageMs } : {}),
    })
  }
  return incomplete.sort((a, b) => a.runId.localeCompare(b.runId))
}

// Incomplete = journal exists, still running (not complete/failed), and not quarantined
export async function findIncompleteRuns(layout: ArchiveLayout): Promise<string[]> {
  const refs = await findIncompleteRunRefs(layout)
  return refs.filter((ref) => ref.status === "running").map((ref) => ref.runId)
}

export const resumeApi: ResumeApi = Object.freeze({
  findIncompleteRuns,
  nextPhase,
})

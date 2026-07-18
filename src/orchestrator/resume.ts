import { existsSync, readFileSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import type { ArchiveLayout } from "../lib/archive.js"
import { assertRunId } from "../lib/run-id.js"
import type { ResumeApi } from "../contracts/interfaces.js"
import { RUN_PHASES, type RunJournal, type RunPhase } from "./journal.js"
import { isQuarantined } from "./quarantine.js"

export function nextPhase(journal: RunJournal): RunPhase | undefined {
  const index = RUN_PHASES.indexOf(journal.phase)
  if (index < 0) return undefined
  return RUN_PHASES[index + 1]
}

// Incomplete = journal exists, still running (not complete/failed), and not quarantined
export async function findIncompleteRuns(layout: ArchiveLayout): Promise<string[]> {
  if (!existsSync(layout.transactions)) return []
  const files = await readdir(layout.transactions)
  const incomplete: string[] = []
  for (const file of files) {
    if (!file.endsWith(".json")) continue
    const runId = file.slice(0, -".json".length)
    try {
      assertRunId(runId)
    } catch {
      continue
    }
    const journal = JSON.parse(readFileSync(join(layout.transactions, file), "utf8")) as RunJournal
    if (journal.phase === "complete" || journal.status === "complete" || journal.status === "failed") {
      continue
    }
    if (isQuarantined(layout, runId)) continue
    incomplete.push(runId)
  }
  return incomplete.sort()
}

export const resumeApi: ResumeApi = Object.freeze({
  findIncompleteRuns,
  nextPhase,
})

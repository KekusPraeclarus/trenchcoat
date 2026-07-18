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
import { RUN_PHASES, type RunJournal } from "./journal.js"

function parseJournal(raw: unknown): RunJournal {
  if (typeof raw !== "object" || raw === null) {
    throw new TypeError("Journal is not an object")
  }
  const candidate = raw as Record<string, unknown>
  assertRunId(String(candidate["runId"]))
  if (!RUN_PHASES.includes(candidate["phase"] as never)) {
    throw new TypeError("Journal phase is invalid")
  }
  const phase = candidate["phase"] as RunJournal["phase"]
  const statusRaw = candidate["status"]
  if (statusRaw !== "complete" && statusRaw !== "failed" && statusRaw !== "running") {
    throw new TypeError(`Journal status is invalid: ${String(statusRaw)}`)
  }
  const status = statusRaw
  if (phase === "complete" && status !== "complete") {
    throw new TypeError("Journal phase complete requires status complete")
  }
  return {
    ...(raw as RunJournal),
    status,
  }
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

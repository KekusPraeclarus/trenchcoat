import { existsSync } from "node:fs"
import { join } from "node:path"
import { quarantineDir, writeJsonRecordFsync, type ArchiveLayout } from "../lib/archive.js"
import { assertRunId } from "../lib/run-id.js"
import { QuarantineConflictSchema, type QuarantineConflict } from "../contracts/schemas.js"
import type { QuarantineApi } from "../contracts/interfaces.js"
import type { RunJournal } from "./journal.js"

function conflictPath(layout: ArchiveLayout, runId: string): string {
  return join(quarantineDir(layout, runId), "conflict.json")
}

export function isQuarantined(layout: ArchiveLayout, runId: string): boolean {
  assertRunId(runId)
  return existsSync(conflictPath(layout, runId))
}

// A quarantined run is frozen for operator review; the journal snapshot preserves the divergent state
export async function quarantineRun(
  layout: ArchiveLayout,
  conflict: QuarantineConflict,
  journal?: RunJournal,
): Promise<void> {
  const validated = QuarantineConflictSchema.parse(conflict)
  assertRunId(validated.runId)
  const dir = quarantineDir(layout, validated.runId)
  await writeJsonRecordFsync(join(dir, "conflict.json"), validated as never)
  if (journal) {
    await writeJsonRecordFsync(join(dir, "journal.json"), journal as never)
  }
}

export const quarantineApi: QuarantineApi = Object.freeze({
  quarantine: quarantineRun,
  isQuarantined,
})

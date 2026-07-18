import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive, quarantineDir } from "../../src/lib/archive.js"
import { isQuarantined, quarantineRun } from "../../src/orchestrator/quarantine.js"
import { findIncompleteRuns } from "../../src/orchestrator/resume.js"
import { createJournalStore } from "../../src/orchestrator/journal-store.js"
import { advanceRunJournal, createRunJournal } from "../../src/orchestrator/journal.js"
import { sha256Json } from "../../src/lib/canonical-json.js"
import type { QuarantineConflict } from "../../src/contracts/schemas.js"

const RUN_ID = "list-scan-2026-07-17T00-00-00-000Z"
const NOW = "2026-07-17T00:00:00.000Z"

function conflict(): QuarantineConflict {
  return {
    schema: 1,
    runId: RUN_ID,
    kind: "phase-hash",
    key: "collected",
    expected: `sha256:${"1".repeat(64)}`,
    observed: `sha256:${"2".repeat(64)}`,
    quarantinedAt: NOW,
    message: "Divergent replay of collected phase",
  }
}

describe("quarantine crash boundary", () => {
  it("freezes a conflicting run with its divergent journal snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-quar-"))
    const layout = await ensureArchive(join(root, "archive"))

    expect(isQuarantined(layout, RUN_ID)).toBe(false)

    const journal = advanceRunJournal(createRunJournal(RUN_ID), "collected", sha256Json({ n: 1 }))
    await quarantineRun(layout, conflict(), journal)

    expect(isQuarantined(layout, RUN_ID)).toBe(true)
    const written = JSON.parse(readFileSync(join(quarantineDir(layout, RUN_ID), "conflict.json"), "utf8"))
    expect(written.kind).toBe("phase-hash")
    const snapshot = JSON.parse(readFileSync(join(quarantineDir(layout, RUN_ID), "journal.json"), "utf8"))
    expect(snapshot.phase).toBe("collected")
  })

  it("is idempotent under a re-quarantine retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-quar-"))
    const layout = await ensureArchive(join(root, "archive"))
    await quarantineRun(layout, conflict())
    await quarantineRun(layout, conflict())
    expect(isQuarantined(layout, RUN_ID)).toBe(true)
  })

  it("excludes quarantined runs from resume discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-quar-"))
    const layout = await ensureArchive(join(root, "archive"))
    const store = createJournalStore(layout)

    const incomplete = advanceRunJournal(createRunJournal(RUN_ID), "collected", sha256Json({ n: 1 }))
    await store.save(incomplete)
    expect(await findIncompleteRuns(layout)).toEqual([RUN_ID])

    await quarantineRun(layout, conflict(), incomplete)
    expect(await findIncompleteRuns(layout)).toEqual([])
  })
})

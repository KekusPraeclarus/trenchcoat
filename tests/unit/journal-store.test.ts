import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive, transactionJournalPath } from "../../src/lib/archive.js"
import {
  createJournalStore,
  tryParseJournal,
} from "../../src/orchestrator/journal-store.js"
import { advanceRunJournal, createRunJournal } from "../../src/orchestrator/journal.js"
import { sha256Json } from "../../src/lib/canonical-json.js"

const RUN_ID = "list-scan-2026-07-17T00-00-00-000Z"

describe("journal store", () => {
  it("round-trips the authoritative journal through the archive", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-js-"))
    const layout = await ensureArchive(join(root, "archive"))
    const store = createJournalStore(layout)

    expect(await store.load(RUN_ID)).toBeUndefined()

    let journal = createRunJournal(RUN_ID)
    journal = advanceRunJournal(journal, "collected", sha256Json({ step: "collected" }))
    await store.save(journal)

    const loaded = await store.load(RUN_ID)
    expect(loaded).toEqual(journal)
    expect(loaded?.phase).toBe("collected")
  })

  it("treats the archive as source of truth over a diverging agent mirror", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-js-"))
    const layout = await ensureArchive(join(root, "archive"))
    const store = createJournalStore(layout)
    const agentRoot = join(root, "agent")

    const journal = createRunJournal(RUN_ID)
    await store.save(journal)
    await store.mirrorToAgent?.(agentRoot, journal)

    const mirrorPath = join(agentRoot, "reports", RUN_ID, "journal.json")
    writeFileSync(mirrorPath, JSON.stringify({ ...journal, phase: "complete" }, null, 2))

    const loaded = await store.load(RUN_ID)
    expect(loaded?.phase).toBe("created")
    expect(JSON.parse(readFileSync(mirrorPath, "utf8")).phase).toBe("complete")
  })

  it("rejects a corrupt journal payload on load", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-js-"))
    const layout = await ensureArchive(join(root, "archive"))
    const store = createJournalStore(layout)
    writeFileSync(transactionJournalPath(layout, RUN_ID), JSON.stringify({ runId: RUN_ID, phase: "nope" }))
    await expect(store.load(RUN_ID)).rejects.toThrow(/phase/u)
  })

  it("loads legacy complete journals missing status", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-js-legacy-"))
    const layout = await ensureArchive(join(root, "archive"))
    const store = createJournalStore(layout)
    writeFileSync(transactionJournalPath(layout, RUN_ID), JSON.stringify({
      schema: 1,
      runId: RUN_ID,
      phase: "complete",
      phaseHashes: {},
      sideEffects: {},
    }))
    const loaded = await store.load(RUN_ID)
    expect(loaded?.status).toBe("complete")
    expect(loaded?.phase).toBe("complete")
  })

  it("derives running for legacy created journals and failed when failure is present", () => {
    const created = tryParseJournal({
      schema: 1,
      runId: RUN_ID,
      phase: "created",
      phaseHashes: {},
      sideEffects: {},
    }, "scan")
    expect(created.ok).toBe(true)
    if (created.ok) {
      expect(created.journal.status).toBe("running")
      expect(created.legacyStatus).toBe(true)
    }

    const failed = tryParseJournal({
      schema: 1,
      runId: RUN_ID,
      phase: "collected",
      phaseHashes: {},
      sideEffects: {},
      failure: {
        lastPhase: "collected",
        code: "run-error",
        message: "boom",
        failedAt: "2026-07-17T00:00:00.000Z",
      },
    }, "scan")
    expect(failed.ok).toBe(true)
    if (failed.ok) {
      expect(failed.journal.status).toBe("failed")
      expect(failed.legacyStatus).toBe(true)
    }
  })

  it("scan mode isolates corrupt journals instead of throwing", () => {
    const bad = tryParseJournal({ runId: RUN_ID, phase: "nope" }, "scan")
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toMatch(/phase/u)
  })
})

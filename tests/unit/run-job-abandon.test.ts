import { describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  maybeAbandonOrphansThrottled,
  ORPHAN_ABANDON_THROTTLE_MS,
} from "../../src/orchestrator/abandon.js"
import { createRunJournal, advanceRunJournal } from "../../src/orchestrator/journal.js"
import { createJournalStore } from "../../src/orchestrator/journal-store.js"
import { ensureArchive } from "../../src/lib/archive.js"
import { sha256Json } from "../../src/lib/canonical-json.js"

describe("maybeAbandonOrphansThrottled", () => {
  it("abandons a stale pre-seal orphan and throttles subsequent calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-throttle-abandon-"))
    const archiveRoot = join(root, "archive")
    const agentRoot = join(root, "agent")
    const home = join(root, "home")
    mkdirSync(agentRoot, { recursive: true })
    mkdirSync(home, { recursive: true })
    const layout = await ensureArchive(archiveRoot)
    const store = createJournalStore(layout)
    const runId = "telegram-alpha-2026-07-20T17-51-14-340Z"
    let journal = createRunJournal(runId)
    journal = advanceRunJournal(journal, "collected", sha256Json({ ok: true }))
    await store.save(journal)

    const first = await maybeAbandonOrphansThrottled({
      agentRoot,
      archiveRoot,
      home,
      nowIso: "2026-07-20T19:30:00.000Z",
    })
    expect(first?.failed).toContain(runId)
    expect((await store.load(runId))?.status).toBe("failed")
    expect(existsSync(join(home, "last-orphan-abandon.json"))).toBe(true)

    const second = await maybeAbandonOrphansThrottled({
      agentRoot,
      archiveRoot,
      home,
      nowIso: "2026-07-20T19:35:00.000Z",
    })
    expect(second).toBeUndefined()

    const throttle = JSON.parse(readFileSync(join(home, "last-orphan-abandon.json"), "utf8")) as {
      lastAttemptAt?: string
    }
    const ageMs = Date.parse("2026-07-20T19:35:00.000Z") - Date.parse(throttle.lastAttemptAt ?? "")
    expect(ageMs).toBeLessThan(ORPHAN_ABANDON_THROTTLE_MS)
  })

  it("does not abandon a fresh running journal", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-throttle-fresh-"))
    const archiveRoot = join(root, "archive")
    const agentRoot = join(root, "agent")
    const home = join(root, "home")
    mkdirSync(agentRoot, { recursive: true })
    mkdirSync(home, { recursive: true })
    const layout = await ensureArchive(archiveRoot)
    const store = createJournalStore(layout)
    const runId = "list-scan-2026-07-20T17-14-07-287Z"
    let journal = createRunJournal(runId)
    journal = advanceRunJournal(journal, "collected", sha256Json({ ok: true }))
    await store.save(journal)

    const result = await maybeAbandonOrphansThrottled({
      agentRoot,
      archiveRoot,
      home,
      nowIso: "2026-07-20T17:20:00.000Z",
    })
    expect(result?.failed ?? []).not.toContain(runId)
    expect((await store.load(runId))?.status).toBe("running")
  })
})

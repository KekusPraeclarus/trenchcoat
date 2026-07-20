import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  beginDeployPause,
  endDeployPause,
  isDeployPaused,
  noteDeferredJob,
  readDeployPause,
} from "../../src/lib/deploy-pause.js"
import {
  shouldAbandonIncomplete,
  ORPHAN_PRESEAL_NO_LOCK_MS,
  ABANDONED_RUNNING_MS,
  failRunJournal,
  abandonOrphanedRuns,
} from "../../src/orchestrator/abandon.js"
import { createRunJournal, advanceRunJournal } from "../../src/orchestrator/journal.js"
import { createJournalStore } from "../../src/orchestrator/journal-store.js"
import { archiveLayout, ensureArchive } from "../../src/lib/archive.js"
import { sha256Json } from "../../src/lib/canonical-json.js"

describe("deploy pause", () => {
  it("round-trips pause, deferred jobs, and clear", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-pause-"))
    expect(isDeployPaused(home)).toBe(false)
    await beginDeployPause({ home, reason: "test", nowIso: "2026-07-20T18:00:00.000Z" })
    expect(isDeployPaused(home)).toBe(true)
    expect(readDeployPause(home)?.reason).toBe("test")
    await noteDeferredJob({ home, job: "wallet-scan-solana" })
    await noteDeferredJob({ home, job: "wallet-scan-solana" })
    await noteDeferredJob({ home, job: "research" })
    expect(readDeployPause(home)?.deferredJobs).toEqual(["wallet-scan-solana", "research"])
    const deferred = await endDeployPause(home)
    expect(deferred).toEqual(["wallet-scan-solana", "research"])
    expect(isDeployPaused(home)).toBe(false)
  })
})

describe("orphan abandon predicates", () => {
  it("fails pre-seal orphans without a live lock after 30m", () => {
    expect(shouldAbandonIncomplete({
      ref: {
        runId: "list-scan-2026-07-20T17-14-07-287Z",
        status: "running",
        phase: "collected",
        ageMs: ORPHAN_PRESEAL_NO_LOCK_MS,
      },
      lockHeld: false,
    })).toBe(true)
    expect(shouldAbandonIncomplete({
      ref: {
        runId: "list-scan-2026-07-20T17-14-07-287Z",
        status: "running",
        phase: "collected",
        ageMs: ORPHAN_PRESEAL_NO_LOCK_MS,
      },
      lockHeld: true,
    })).toBe(false)
  })

  it("fails any running journal past the hard age cap", () => {
    expect(shouldAbandonIncomplete({
      ref: {
        runId: "research-2026-07-20T10-00-00-000Z",
        status: "running",
        phase: "committed",
        ageMs: ABANDONED_RUNNING_MS,
      },
      lockHeld: true,
    })).toBe(true)
  })

  it("only fails created-abandoned when requested", () => {
    const ref = {
      runId: "list-scan-2026-07-17T21-36-41-510Z",
      status: "abandoned" as const,
      phase: "created" as const,
      ageMs: ABANDONED_RUNNING_MS,
    }
    expect(shouldAbandonIncomplete({ ref, lockHeld: false })).toBe(false)
    expect(shouldAbandonIncomplete({
      ref,
      lockHeld: false,
      includeCreatedAbandoned: true,
    })).toBe(true)
  })
})

describe("failRunJournal / abandonOrphanedRuns", () => {
  it("marks a running journal failed", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-fail-"))
    const archiveRoot = join(root, "archive")
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "reports"), { recursive: true })
    const layout = await ensureArchive(archiveRoot)
    const store = createJournalStore(layout)
    const runId = "list-scan-2026-07-20T17-14-07-287Z"
    let journal = createRunJournal(runId)
    journal = advanceRunJournal(journal, "collected", sha256Json({ ok: true }))
    await store.save(journal)

    const failed = await failRunJournal({
      archiveRoot,
      agentRoot,
      runId,
      code: "operator-abandon",
      message: "test",
      nowIso: "2026-07-20T18:30:00.000Z",
    })
    expect(failed.status).toBe("failed")
    expect(failed.failure?.code).toBe("operator-abandon")
    expect((await store.load(runId))?.status).toBe("failed")
  })

  it("abandons pre-seal orphans when lock is free", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-abandon-"))
    const archiveRoot = join(root, "archive")
    const agentRoot = join(root, "agent")
    mkdirSync(agentRoot, { recursive: true })
    const layout = await ensureArchive(archiveRoot)
    const store = createJournalStore(layout)
    const runId = "telegram-alpha-2026-07-20T17-51-14-340Z"
    let journal = createRunJournal(runId)
    journal = advanceRunJournal(journal, "collected", sha256Json({ ok: true }))
    await store.save(journal)

    // Age from runId stamp (~17:51) vs now 19:30 → >30m
    const result = await abandonOrphanedRuns({
      agentRoot,
      archiveRoot,
      nowIso: "2026-07-20T19:30:00.000Z",
    })
    expect(result.failed).toContain(runId)
    expect((await store.load(runId))?.status).toBe("failed")
    expect(existsSync(join(agentRoot, ".lock"))).toBe(false)
  })
})

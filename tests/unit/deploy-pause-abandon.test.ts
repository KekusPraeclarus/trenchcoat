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
  DEPLOY_PAUSE_MAX_AGE_MS,
  DEPLOY_PAUSE_MAX_RUNNING_MS,
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
    const nowIso = new Date().toISOString()
    await beginDeployPause({ home, reason: "test", nowIso })
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

  it("auto-clears pause files older than DEPLOY_PAUSE_MAX_AGE_MS", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-pause-stale-"))
    const pausedAt = "2026-07-23T19:54:42.000Z"
    await beginDeployPause({ home, reason: "install-systemd", nowIso: pausedAt })
    const freshMs = Date.parse(pausedAt) + 10 * 60 * 1000
    expect(isDeployPaused(home, freshMs)).toBe(true)
    const staleMs = Date.parse(pausedAt) + DEPLOY_PAUSE_MAX_AGE_MS + 1
    expect(isDeployPaused(home, staleMs)).toBe(false)
    expect(readDeployPause(home, staleMs)).toBeUndefined()
    expect(existsSync(join(home, "deploy-pause.json"))).toBe(false)
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
        phase: "collected",
        ageMs: ABANDONED_RUNNING_MS,
      },
      lockHeld: true,
    })).toBe(true)
  })

  it("fails long-running journals during deploy pause even when lock is live", () => {
    expect(shouldAbandonIncomplete({
      ref: {
        runId: "narrative-scan-2026-07-27T05-11-11-588Z",
        status: "running",
        phase: "collected",
        ageMs: DEPLOY_PAUSE_MAX_RUNNING_MS,
      },
      lockHeld: true,
      deployPauseActive: true,
    })).toBe(true)
    expect(shouldAbandonIncomplete({
      ref: {
        runId: "narrative-scan-2026-07-27T05-11-11-588Z",
        status: "running",
        phase: "collected",
        ageMs: DEPLOY_PAUSE_MAX_RUNNING_MS - 1,
      },
      lockHeld: true,
      deployPauseActive: true,
    })).toBe(false)
    expect(shouldAbandonIncomplete({
      ref: {
        runId: "narrative-scan-2026-07-27T05-11-11-588Z",
        status: "running",
        phase: "collected",
        ageMs: DEPLOY_PAUSE_MAX_RUNNING_MS,
      },
      lockHeld: true,
      deployPauseActive: false,
    })).toBe(false)
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

  it("abandons long-running journals during deploy pause", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-deploy-abandon-"))
    const archiveRoot = join(root, "archive")
    const agentRoot = join(root, "agent")
    const home = join(root, "home")
    mkdirSync(agentRoot, { recursive: true })
    mkdirSync(home, { recursive: true })
    const layout = await ensureArchive(archiveRoot)
    const store = createJournalStore(layout)
    const runId = "narrative-scan-2026-07-27T05-11-11-588Z"
    let journal = createRunJournal(runId)
    journal = advanceRunJournal(journal, "collected", sha256Json({ ok: true }))
    await store.save(journal)
    await beginDeployPause({ home, reason: "install-systemd", nowIso: "2026-07-27T06:21:00.000Z" })

    const result = await abandonOrphanedRuns({
      agentRoot,
      archiveRoot,
      home,
      nowIso: "2026-07-27T06:51:02.000Z",
    })
    expect(result.failed).toContain(runId)
    const failed = await store.load(runId)
    expect(failed?.status).toBe("failed")
    expect(failed?.failure?.code).toBe("deploy-wait-timeout")
    await endDeployPause(home)
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

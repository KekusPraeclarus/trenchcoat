import { describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../../src/lib/state.js"
import { runJob } from "../../src/orchestrator/run.js"
import {
  evaluateJobPreconditions,
  precheckJob,
  skipLedgerPath,
} from "../../src/orchestrator/preconditions.js"

const NOW = "2026-07-18T12:00:00.000Z"

function emptyWorkspace(): { agentRoot: string; archiveRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "tc-precond-"))
  const agentRoot = join(root, "agent")
  const archiveRoot = join(root, "archive")
  mkdirSync(join(agentRoot, "state"), { recursive: true })
  return { agentRoot, archiveRoot }
}

describe("job preconditions", () => {
  it("skips chart-sweep and watchlist-scan before creating run artifacts", async () => {
    for (const job of ["chart-sweep", "watchlist-scan"] as const) {
      const { agentRoot, archiveRoot } = emptyWorkspace()
      const state = new StateStore(join(agentRoot, "state"))
      await state.saveWatchlist({ schema: 1, entries: [] })

      const result = await runJob({
        job,
        paths: { agentRoot, archiveRoot },
      })

      expect(result).toMatchObject({ runId: "none", exitCode: 0 })
      expect(result.journal).toBeUndefined()
      expect(existsSync(join(agentRoot, "reports"))).toBe(false)
      expect(existsSync(join(agentRoot, "inbox"))).toBe(false)
      const runsDir = join(archiveRoot, "runs")
      if (existsSync(runsDir)) {
        expect(readdirSync(runsDir)).toEqual([])
      }
      const txDir = join(archiveRoot, "transactions")
      if (existsSync(txDir)) {
        expect(readdirSync(txDir)).toEqual([])
      }
      const ledger = skipLedgerPath(archiveRoot, job)
      expect(existsSync(ledger)).toBe(true)
      const line = readFileSync(ledger, "utf8").trim()
      expect(JSON.parse(line)).toMatchObject({
        schema: 1,
        job,
        reason: "no-active-watchlist-subjects",
      })
    }
  })

  it("skips both farcaster jobs when the lane is disabled", async () => {
    for (const job of ["farcaster-scan", "fc-source-review"] as const) {
      const { agentRoot, archiveRoot } = emptyWorkspace()
      const result = await evaluateJobPreconditions({
        job,
        agentRoot,
        archiveRoot,
        nowIso: NOW,
      })
      expect(result).toMatchObject({ skip: true, reason: "farcaster-disabled" })
    }
  })

  it("wallet-discovery skips when subjects lack wallet-supported chains", async () => {
    const { agentRoot, archiveRoot } = emptyWorkspace()
    const state = new StateStore(join(agentRoot, "state"))
    await state.saveWatchlist({
      schema: 1,
      entries: [{
        schema: 1,
        identity: {
          chain: "bsc",
          tokenAddress: "0x0000000000000000000000000000000000000001",
          pairAddress: "0x0000000000000000000000000000000000000002",
          symbolDisplay: "BNB",
          resolution: "resolved",
        },
        status: "tracking",
        addedAt: NOW,
        updatedAt: NOW,
      }],
    })
    await state.saveWallets({
      schema: 1,
      wallets: [],
      transitions: [],
      pendingTransitionIds: [],
      cursors: [],
      exclusions: [],
    })

    const pre = await evaluateJobPreconditions({
      job: "wallet-discovery",
      agentRoot,
      archiveRoot,
      nowIso: NOW,
    })
    expect(pre).toMatchObject({ skip: true, reason: "no-wallet-supported-subjects" })

    const result = await runJob({
      job: "wallet-discovery",
      paths: { agentRoot, archiveRoot },
    })
    expect(result.runId).toBe("none")
    expect(existsSync(join(agentRoot, "reports"))).toBe(false)
  })

  it("research skips with queue-pending when the only entry is not yet due", async () => {
    const { agentRoot, archiveRoot } = emptyWorkspace()
    const state = new StateStore(join(agentRoot, "state"))
    await state.saveResearchQueue({
      schema: 1,
      entries: [{
        schema: 1,
        queueId: "rq-revisit-pending",
        subject: "PENDING",
        priority: 80,
        firstSeen: NOW,
        enqueuedAt: NOW,
        enqueuedBy: "revisit",
        trigger: "revisit",
        revisitAfter: "2026-07-18T18:00:00.000Z",
        expiresAt: "2026-07-25T12:00:00.000Z",
        provenance: ["revisit:PENDING"],
        clusterCount: 1,
        security: { status: "pending", flags: [] },
        status: "pending",
        resolution: "pending",
        reason: "scheduled revisit later today",
      }],
      completedToday: { day: "2026-07-18", count: 0 },
    })

    const pre = await evaluateJobPreconditions({
      job: "research",
      agentRoot,
      archiveRoot,
      nowIso: NOW,
    })
    expect(pre).toMatchObject({ skip: true, reason: "queue-pending" })
    expect(pre?.details).toMatchObject({ pending: true })
  })

  it("precheck reports skip without writing ledger", async () => {
    const { agentRoot, archiveRoot } = emptyWorkspace()
    const state = new StateStore(join(agentRoot, "state"))
    await state.saveWatchlist({ schema: 1, entries: [] })

    const result = await precheckJob({
      job: "chart-sweep",
      agentRoot,
      archiveRoot,
      nowIso: NOW,
    })
    expect(result).toMatchObject({
      job: "chart-sweep",
      skip: true,
      reason: "no-active-watchlist-subjects",
    })
    expect(existsSync(skipLedgerPath(archiveRoot, "chart-sweep"))).toBe(false)
  })

  it("applies preconditions under dryCollect", async () => {
    const { agentRoot, archiveRoot } = emptyWorkspace()
    const state = new StateStore(join(agentRoot, "state"))
    await state.saveWatchlist({ schema: 1, entries: [] })

    const pre = await evaluateJobPreconditions({
      job: "chart-sweep",
      agentRoot,
      archiveRoot,
      nowIso: NOW,
      dryCollect: true,
    })
    expect(pre).toMatchObject({ skip: true, reason: "no-active-watchlist-subjects" })

    const result = await runJob({
      job: "chart-sweep",
      paths: { agentRoot, archiveRoot },
      dryCollect: true,
      skipAgent: true,
    })
    expect(result).toMatchObject({ runId: "none", exitCode: 0 })
  })

  it("fails closed when state/ is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-precond-uninit-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(agentRoot, { recursive: true })

    const pre = await evaluateJobPreconditions({
      job: "watchlist-scan",
      agentRoot,
      archiveRoot,
      nowIso: NOW,
    })
    expect(pre).toMatchObject({ skip: true, reason: "not-initialized" })

    const check = await precheckJob({
      job: "watchlist-scan",
      agentRoot,
      archiveRoot,
      nowIso: NOW,
    })
    expect(check).toMatchObject({
      job: "watchlist-scan",
      skip: true,
      reason: "not-initialized",
    })
  })

  it("review no longer skips solely for empty traditional scope", async () => {
    const { agentRoot, archiveRoot } = emptyWorkspace()
    const state = new StateStore(join(agentRoot, "state"))
    await state.saveWatchlist({ schema: 1, entries: [] })

    const result = await runJob({
      job: "review",
      paths: { agentRoot, archiveRoot },
      skipAgent: true,
      dryCollect: true,
    })
    expect(result.runId).not.toBe("none")
    expect(result.exitCode).toBe(0)
    const ledger = skipLedgerPath(archiveRoot, "review")
    expect(existsSync(ledger)).toBe(false)
  })
})

import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { archiveLayout } from "../../src/lib/archive.js"
import { StateStore } from "../../src/lib/state.js"
import { runLedgerSettle } from "../../src/orchestrator/settle-ledger.js"
import { jobRequiresAgentWorkspaceLock } from "../../src/lib/lock.js"
import { selectWalletsForScan } from "../../src/orchestrator/wallet-scan.js"
import type { WalletRecord, WalletScanCursor } from "../../src/contracts/schemas.js"

const identity = {
  chain: "solana" as const,
  tokenAddress: "So11111111111111111111111111111111111111112",
  pairAddress: "pair1111111111111111111111111111111111111111",
  symbolDisplay: "SOL",
  resolution: "resolved" as const,
}

describe("agent lock exemptions for settle/scan/review", () => {
  it("exempts outcomes-settle, wallet-scan, and wallet-review from full-job lock", () => {
    expect(jobRequiresAgentWorkspaceLock("outcomes-settle")).toBe(false)
    expect(jobRequiresAgentWorkspaceLock("wallet-scan-solana")).toBe(false)
    expect(jobRequiresAgentWorkspaceLock("wallet-scan-evm")).toBe(false)
    expect(jobRequiresAgentWorkspaceLock("wallet-review")).toBe(false)
    expect(jobRequiresAgentWorkspaceLock("list-scan")).toBe(true)
  })
})

describe("selectWalletsForScan", () => {
  it("caps and prefers wallets with oldest cursors", () => {
    const wallets: WalletRecord[] = [
      {
        schema: 1,
        walletId: "solana:a",
        chain: "solana",
        address: "a",
        status: "candidate",
        addedAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:00:00.000Z",
        hardExcluded: false,
      },
      {
        schema: 1,
        walletId: "solana:b",
        chain: "solana",
        address: "b",
        status: "candidate",
        addedAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:00:00.000Z",
        hardExcluded: false,
      },
      {
        schema: 1,
        walletId: "solana:c",
        chain: "solana",
        address: "c",
        status: "candidate",
        addedAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:00:00.000Z",
        hardExcluded: false,
      },
    ]
    const cursors: WalletScanCursor[] = [
      {
        schema: 1,
        chain: "solana",
        kind: "wallet-scan-tip",
        subject: "a",
        cursor: "sig-a",
        updatedAt: "2026-07-23T12:00:00.000Z",
      },
      {
        schema: 1,
        chain: "solana",
        kind: "wallet-scan-tip",
        subject: "b",
        cursor: "sig-b",
        updatedAt: "2026-07-23T01:00:00.000Z",
      },
    ]
    const selected = selectWalletsForScan(wallets, cursors, 2)
    expect(selected.map((w) => w.address)).toEqual(["c", "b"])
  })
})

describe("runLedgerSettle", () => {
  it("finalizes entry-pending at first post-decision bar", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-ledger-settle-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    const layout = archiveLayout(archiveRoot)
    mkdirSync(layout.decisions, { recursive: true })

    const decisionId = "dec-track-1"
    writeFileSync(join(layout.decisions, `${decisionId}.json`), `${JSON.stringify({
      schema: 1,
      decisionId,
      runId: "research-1",
      decisionTs: "2026-07-20T12:00:00.000Z",
      card: {
        decisionId,
        runId: "research-1",
        decisionTs: "2026-07-20T12:00:00.000Z",
        verdict: "track",
        identity,
        thesis: "t",
        horizonHours: 72,
        invalidation: "i",
        drivers: ["social"],
        confidence: 60,
        signalUse: { rsi: "observed" },
        sources: ["twitter:@a"],
        clusters: 1,
        countercase: "c",
        gate: "pass",
      },
      provenanceIds: ["twitter:@a"],
      inboxManifestHash: `sha256:${"a".repeat(64)}`,
      sourceScoresSnapshotHash: `sha256:${"b".repeat(64)}`,
      marketBlobRefs: [],
      runConfigHash: `sha256:${"c".repeat(64)}`,
      policyVersion: "baseline",
      assignment: "baseline",
      signals: {},
    }, null, 2)}\n`)

    const store = new StateStore(join(agentRoot, "state"))
    await store.saveLedger({
      schema: 1,
      positions: [{
        schema: 1,
        positionId: `pos-${decisionId}`,
        decisionId,
        identity,
        status: "entry-pending",
        openedAt: "2026-07-20T12:05:00.000Z",
      }],
    })

    const report = await runLedgerSettle({
      agentRoot,
      layout,
      nowIso: "2026-07-20T14:00:00.000Z",
      acquireLock: false,
      loadBars: async () => [
        { ts: "2026-07-20T11:55:00.000Z", open: 9, finalized: true },
        { ts: "2026-07-20T12:05:00.000Z", open: 10, finalized: true },
      ],
    })

    expect(report.entriesFinalized).toBe(1)
    const pos = store.loadLedger().positions[0]
    expect(pos?.status).toBe("open")
    expect(pos?.entryPrice).toBe(10)
  })
})

import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  OperatorSeedFileSchema,
  buildOperatorSeededWallet,
  seedWalletsFromOperatorList,
} from "../../src/wallets/seed.js"
import { applyOperatorWalletSeed } from "../../src/orchestrator/wallet-seed.js"
import { StateStore } from "../../src/lib/state.js"
import { normalizeEvmAddress } from "../../src/lib/address.js"

const SOL = "11111111111111111111111111111111"
const EVM_LOWER = "0x742d35cc6634c0532925a3b844bc454e4438f44e"
const EMPTY_WALLETS = {
  schema: 1 as const,
  wallets: [] as [],
  transitions: [] as [],
  pendingTransitionIds: [] as [],
  cursors: [] as [],
}

describe("operator wallet seed", () => {
  it("builds tracking-probation records with operator-seed transitions", () => {
    const now = "2026-07-16T18:00:00.000Z"
    const { file, transitions, added } = seedWalletsFromOperatorList({
      entries: [
        { chain: "solana", address: SOL, note: "alpha desk" },
        { chain: "ethereum", address: EVM_LOWER },
      ],
      existing: EMPTY_WALLETS,
      nowIso: now,
      runId: "run-seed-1",
    })
    expect(added).toBe(2)
    expect(file.wallets).toHaveLength(2)
    expect(file.wallets[0]).toMatchObject({
      walletId: `solana:${SOL}`,
      status: "tracking-probation",
      operatorReason: "alpha desk",
    })
    expect(file.wallets[1]?.address).toBe(normalizeEvmAddress(EVM_LOWER))
    expect(transitions).toHaveLength(2)
    expect(transitions.every((t) => t.reasonCode === "operator-seed")).toBe(true)
    expect(transitions.every((t) => t.action === "added")).toBe(true)
  })

  it("refuses unsupported chains, duplicates, and non-empty state", () => {
    const now = "2026-07-16T18:00:00.000Z"
    expect(() => buildOperatorSeededWallet({ chain: "bsc", address: EVM_LOWER }, now))
      .toThrow(/unsupported/i)
    expect(() => seedWalletsFromOperatorList({
      entries: [
        { chain: "solana", address: SOL },
        { chain: "solana", address: SOL },
      ],
      existing: EMPTY_WALLETS,
      nowIso: now,
      runId: "run-seed-2",
    })).toThrow(/Duplicate/)
    expect(() => seedWalletsFromOperatorList({
      entries: [{ chain: "solana", address: SOL }],
      existing: {
        ...EMPTY_WALLETS,
        wallets: [buildOperatorSeededWallet({ chain: "solana", address: SOL }, now)],
      },
      nowIso: now,
      runId: "run-seed-3",
    })).toThrow(/not empty/)
  })

  it("persists wallets.json, stages router events, and archives a truthful receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-wallet-seed-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    const store = new StateStore(join(agentRoot, "state"))
    await store.saveWallets({ ...EMPTY_WALLETS, wallets: [] })
    const seedPath = join(root, "operator-seed.json")
    const seed = OperatorSeedFileSchema.parse({
      schema: 1,
      wallets: [{ chain: "solana", address: SOL, note: "seed me" }],
      watchlist: [{ chain: "solana", token_address: SOL, thesis: "ignored for now" }],
      sources: ["twitter:@x"],
    })
    const { writeFileSync } = await import("node:fs")
    writeFileSync(seedPath, `${JSON.stringify(seed, null, 2)}\n`)

    const report = await applyOperatorWalletSeed({
      agentRoot,
      archiveRoot,
      seedPath,
      runId: "wallet-seed-test",
      nowIso: "2026-07-16T18:00:00.000Z",
    })
    expect(report.added).toBe(1)
    expect(report.skippedWatchlist).toBe(1)
    expect(report.skippedSources).toBe(1)
    expect(report.staged).toBe(1)
    expect(report.routerStaged).toBe(true)
    expect(store.loadWallets().wallets[0]?.status).toBe("tracking-probation")
    const receipt = JSON.parse(readFileSync(report.receiptPath, "utf8")) as {
      routerStaged: boolean
      staged: number
      transitions: unknown[]
    }
    expect(receipt.routerStaged).toBe(true)
    expect(receipt.staged).toBe(1)
    expect(receipt.transitions).toHaveLength(1)

    const { Outbox } = await import("../../src/lib/outbox.js")
    const outbox = new Outbox(join(archiveRoot, "router-outbox", "wallet-seed-test"))
    expect(outbox.list()).toHaveLength(1)
    expect(outbox.list()[0]?.type).toBe("wallet.lifecycle")
  })

  it("refuses to seed while the workspace writer lock is held", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-wallet-seed-lock-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    const store = new StateStore(join(agentRoot, "state"))
    await store.saveWallets({ ...EMPTY_WALLETS, wallets: [] })
    const seedPath = join(root, "operator-seed.json")
    const { writeFileSync } = await import("node:fs")
    writeFileSync(seedPath, `${JSON.stringify({
      schema: 1,
      wallets: [{ chain: "solana", address: SOL }],
    }, null, 2)}\n`)

    const { WorkspaceLock, agentLockPath } = await import("../../src/lib/lock.js")
    const lock = new WorkspaceLock(agentLockPath(agentRoot))
    expect(lock.tryAcquire()).toBe(true)
    await expect(applyOperatorWalletSeed({
      agentRoot,
      archiveRoot,
      seedPath,
      runId: "wallet-seed-locked",
    })).rejects.toThrow(/workspace lock held/i)
    lock.release()
  })

  it("skips router staging when external effects are blocked", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-wallet-seed-block-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    const store = new StateStore(join(agentRoot, "state"))
    await store.saveWallets({ ...EMPTY_WALLETS, wallets: [] })
    const seedPath = join(root, "operator-seed.json")
    const { writeFileSync } = await import("node:fs")
    writeFileSync(seedPath, `${JSON.stringify({
      schema: 1,
      wallets: [{ chain: "solana", address: SOL }],
    }, null, 2)}\n`)

    const report = await applyOperatorWalletSeed({
      agentRoot,
      archiveRoot,
      seedPath,
      runId: "wallet-seed-blocked",
      blockExternalEffects: true,
    })
    expect(report.added).toBe(1)
    expect(report.staged).toBe(0)
    expect(report.routerStaged).toBe(false)
  })
})

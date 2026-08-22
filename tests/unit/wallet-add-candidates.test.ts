import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addOperatorNominatedCandidates } from "../../src/wallets/discovery.js"
import { buildOperatorSeededWallet } from "../../src/wallets/seed.js"
import { applyOperatorWalletCandidates } from "../../src/orchestrator/wallet-add-candidates.js"
import { StateStore } from "../../src/lib/state.js"
import { normalizeEvmAddress } from "../../src/lib/address.js"

const SOL = "11111111111111111111111111111111"
const ROBINHOOD = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const NOW = "2026-07-24T17:00:00.000Z"
const EMPTY = {
  schema: 1 as const,
  wallets: [] as [],
  transitions: [] as [],
  pendingTransitionIds: [] as [],
  cursors: [] as [],
  exclusions: [] as [],
}

describe("operator wallet add-candidates", () => {
  it("registers unique candidates with operator-nomination origin", () => {
    const result = addOperatorNominatedCandidates(EMPTY, [
      { chain: "robinhood", address: ROBINHOOD, note: "Pons scrape" },
      { chain: "solana", address: SOL },
    ], NOW)
    expect(result.added).toBe(2)
    expect(result.addedWalletIds).toHaveLength(2)
    expect(result.file.wallets).toHaveLength(2)
    const robinhood = result.file.wallets.find((w) => w.chain === "robinhood")
    expect(robinhood).toMatchObject({
      status: "candidate",
      discoveredFrom: "operator-nomination",
      operatorReason: "Pons scrape",
      address: normalizeEvmAddress(ROBINHOOD),
    })
  })

  it("skips existing and excluded wallets without overwriting", () => {
    const existing = buildOperatorSeededWallet({ chain: "solana", address: SOL }, NOW)
    const excluded = {
      ...existing,
      walletId: `robinhood:${normalizeEvmAddress(ROBINHOOD)}`,
      chain: "robinhood" as const,
      address: normalizeEvmAddress(ROBINHOOD),
      status: "excluded" as const,
      hardExcluded: true,
    }
    const file = {
      ...EMPTY,
      wallets: [existing, excluded],
    }
    const result = addOperatorNominatedCandidates(file, [
      { chain: "solana", address: SOL },
      { chain: "robinhood", address: ROBINHOOD },
      { chain: "ethereum", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    ], NOW)
    expect(result.added).toBe(1)
    expect(result.skippedExisting).toBe(1)
    expect(result.skippedExcluded).toBe(1)
    expect(result.file.wallets).toHaveLength(3)
  })

  it("persists candidates, archives a receipt, and supports dry-run", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-wallet-add-candidates-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    const store = new StateStore(join(agentRoot, "state"))
    await store.saveWallets({ ...EMPTY, wallets: [] })
    const seedPath = join(root, "candidates.json")
    writeFileSync(seedPath, `${JSON.stringify({
      schema: 1,
      wallets: [{ chain: "robinhood", address: ROBINHOOD, note: "lead" }],
    }, null, 2)}\n`)

    const dry = await applyOperatorWalletCandidates({
      agentRoot,
      archiveRoot,
      seedPath,
      runId: "wallet-add-candidates-dry",
      nowIso: NOW,
      dryRun: true,
    })
    expect(dry.added).toBe(1)
    expect(dry.dryRun).toBe(true)
    expect(store.loadWallets().wallets).toHaveLength(0)

    const report = await applyOperatorWalletCandidates({
      agentRoot,
      archiveRoot,
      seedPath,
      runId: "wallet-add-candidates-live",
      nowIso: NOW,
    })
    expect(report.added).toBe(1)
    expect(store.loadWallets().wallets[0]?.status).toBe("candidate")
    const receipt = JSON.parse(readFileSync(report.receiptPath, "utf8")) as {
      walletIds: string[]
      dryRun: boolean
    }
    expect(receipt.walletIds).toHaveLength(1)
    expect(receipt.dryRun).toBe(false)
  })
})

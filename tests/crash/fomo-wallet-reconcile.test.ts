import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../../src/lib/state.js"
import { reconcileInvalidFomoWallets } from "../../src/wallets/fomo-reconcile.js"
import type { WalletsFile } from "../../src/contracts/schemas.js"

const SOL = "11111111111111111111111111111111"

describe("fomo wallet reconcile resume", () => {
  it("is idempotent across restarts", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-fomo-reconcile-"))
    const store = new StateStore(join(root, "state"))
    const file: WalletsFile = {
      schema: 1,
      wallets: [{
        schema: 1,
        walletId: `solana:${SOL}`,
        chain: "solana",
        address: SOL,
        status: "candidate",
        discoveredFrom: "fomo",
        addedAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
        hardExcluded: false,
      }],
      transitions: [],
      pendingTransitionIds: [],
      cursors: [],
      exclusions: [],
    }
    const first = reconcileInvalidFomoWallets(file, "2026-07-21T01:00:00.000Z")
    await store.saveWallets(first.file)
    const second = reconcileInvalidFomoWallets(store.loadWallets(), "2026-07-21T02:00:00.000Z")
    expect(second.unchanged).toBe(true)
    expect(second.file.wallets[0]?.status).toBe("excluded")
  })
})

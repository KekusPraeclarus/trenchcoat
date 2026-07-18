import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../../src/lib/state.js"
import { registerWalletCandidates } from "../../src/wallets/discovery.js"
import { Outbox } from "../../src/lib/outbox.js"
import { buildWalletTransition, transitionToRouterEvent } from "../../src/wallets/lifecycle.js"
import { sha256Json } from "../../src/lib/canonical-json.js"
import type { WalletsFile } from "../../src/contracts/schemas.js"

const SOL = "11111111111111111111111111111111"

describe("wallet discovery crash resume", () => {
  it("persists cursors so a second pass resumes from checkpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-wallet-cursor-"))
    const store = new StateStore(join(root, "state"))
    let file: WalletsFile = {
      schema: 1,
      wallets: [],
      transitions: [],
      pendingTransitionIds: [],
      cursors: [],
    }
    file = registerWalletCandidates(file, [
      { chain: "solana", address: SOL, origin: "watchlist" },
    ], "2026-07-16T18:00:00.000Z")
    file = {
      ...file,
      cursors: [{
        schema: 1,
        chain: "solana",
        kind: "token-discovery",
        subject: SOL,
        cursor: "sig-checkpoint-1",
        updatedAt: "2026-07-16T18:00:00.000Z",
      }],
    }
    await store.saveWallets(file)
    const reloaded = store.loadWallets()
    expect(reloaded.cursors[0]?.cursor).toBe("sig-checkpoint-1")
    expect(reloaded.wallets[0]?.status).toBe("candidate")
  })

  it("stages idempotent wallet.lifecycle router events", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-wallet-outbox-"))
    const outbox = new Outbox(join(root, "outbox"))
    const wallet = {
      schema: 1 as const,
      walletId: `solana:${SOL}`,
      chain: "solana" as const,
      address: SOL,
      status: "tracking" as const,
      addedAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      hardExcluded: false,
    }
    const transition = buildWalletTransition({
      wallet,
      action: "added",
      reasonCode: "promoted",
      reasonLine: "promoted from discovery candidate",
      occurredAt: "2026-07-16T18:00:00.000Z",
      runId: "run-1",
      evidenceHash: sha256Json({ walletId: wallet.walletId, action: "added" }),
    })
    await outbox.stage(transitionToRouterEvent(transition))
    await outbox.stage(transitionToRouterEvent(transition))
    const events = outbox.list()
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe("wallet.lifecycle")
  })
})

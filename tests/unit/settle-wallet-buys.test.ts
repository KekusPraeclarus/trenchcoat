import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { archiveLayout } from "../../src/lib/archive.js"
import { runSettleWalletBuys } from "../../src/orchestrator/settle-wallet-buys.js"
import { readOutcomeObservation } from "../../src/orchestrator/scorecard.js"
import { WalletBuyOutcomeSchema, type WalletBuyOutcome } from "../../src/contracts/schemas.js"
import type { PriceBar } from "../../src/orchestrator/observations.js"

const TOKEN = "So11111111111111111111111111111111111111112"
const BOUGHT = "2026-07-01T00:00:00.000Z"
const NOW = "2026-07-20T00:00:00.000Z"

function buy(partial: Partial<WalletBuyOutcome> & Pick<WalletBuyOutcome, "eventId">): WalletBuyOutcome {
  return {
    schema: 1,
    walletId: "solana:w1",
    chain: "solana",
    tokenAddress: TOKEN,
    boughtAt: BOUGHT,
    finalized: true,
    removed: false,
    priceable: true,
    rug: false,
    ...partial,
  }
}

function seedBatch(root: string, outcomes: WalletBuyOutcome[]): string {
  const dir = join(root, "outcomes")
  mkdirSync(dir, { recursive: true })
  const name = "wallet-buy-run-1.json"
  writeFileSync(join(dir, name), `${JSON.stringify({ schema: 1, runId: "run-1", outcomes }, null, 2)}\n`)
  return name
}

describe("runSettleWalletBuys", () => {
  it("prices finalized buys, censors removed, pends unfinalized, and never invents a loss", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-wb-settle-"))
    const layout = archiveLayout(root)
    seedBatch(root, [
      buy({ eventId: "wb_ok" }),
      buy({ eventId: "wb_removed", removed: true }),
      buy({ eventId: "wb_unfinal", finalized: false }),
    ])

    const bars: PriceBar[] = [
      { ts: "2026-07-01T00:05:00.000Z", open: 10, finalized: true },
      { ts: "2026-07-04T00:05:00.000Z", open: 20, finalized: true },
    ]
    const report = await runSettleWalletBuys({
      layout,
      nowIso: NOW,
      horizons: [72],
      loadBars: (o) => (o.eventId === "wb_ok" ? bars : []),
    })
    expect(report.written).toBe(3)
    expect(report.complete).toBe(1)
    expect(report.censored).toBe(1) // removed
    expect(report.pending).toBe(1)  // unfinalized

    const ok = readOutcomeObservation(layout, "wallet-buy", "wb_ok", 72)
    expect(ok?.status).toBe("complete")
    expect(ok?.rawReturn).toBeCloseTo(1)

    const removed = readOutcomeObservation(layout, "wallet-buy", "wb_removed", 72)
    expect(removed?.status).toBe("censored")
    expect(removed?.status).not.toBe("terminal-loss")

    const unfinal = readOutcomeObservation(layout, "wallet-buy", "wb_unfinal", 72)
    expect(unfinal?.status).toBe("provider-pending")
  })

  it("writes 72h settled fields back onto the WalletBuyOutcome for lifecycle consumers", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-wb-merge-"))
    const layout = archiveLayout(root)
    const name = seedBatch(root, [buy({ eventId: "wb_ok" })])

    const bars: PriceBar[] = [
      { ts: "2026-07-01T00:05:00.000Z", open: 10, finalized: true },
      { ts: "2026-07-04T00:05:00.000Z", open: 20, finalized: true },
    ]
    const report = await runSettleWalletBuys({
      layout,
      nowIso: NOW,
      horizons: [24, 72, 168],
      loadBars: () => bars,
    })
    expect(report.buysUpdated).toBe(1)

    const body = JSON.parse(readFileSync(join(root, "outcomes", name), "utf8")) as { outcomes: unknown[] }
    const merged = WalletBuyOutcomeSchema.parse(body.outcomes[0])
    expect(merged.settledAt).toBe(NOW)
    expect(merged.excessReturn72h).toBeCloseTo(1)

    // resumable: a second run makes no further changes
    const rerun = await runSettleWalletBuys({ layout, nowIso: NOW, horizons: [24, 72, 168], loadBars: () => bars })
    expect(rerun.buysUpdated).toBe(0)
  })
})

import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const live = process.env["TRENCHCOAT_LIVE_E2E"] === "1"

describe.runIf(live)("live e2e gates", () => {
  it("requires credentials for live suite", () => {
    const required = [
      "TRENCHCOAT_ROUTER_HMAC_KEY",
      "TELEGRAM_BOT_TOKEN",
      "HELIUS_API_KEY",
      "INFURA_API_KEY",
    ] as const
    const missing = required.filter((key) => !process.env[key]?.trim())
    expect(missing, `missing env (is .env loaded?): ${missing.join(", ")}`).toEqual([])
  })

  it("managed list config is present or creatable", async () => {
    const { loadConfig } = await import("../../src/lib/config.js")
    const { existsSync } = await import("node:fs")
    const { join: pathJoin } = await import("node:path")
    const { homedir } = await import("node:os")
    const cfg = loadConfig()
    expect(cfg.twitter.operator_list_urls).toHaveLength(2)
    expect(cfg.twitter.scrape_home).toBe(true)
    expect(cfg.twitter.engagement.enabled).toBeTypeOf("boolean")
    const session = pathJoin(homedir(), ".trenchcoat", "twitter-profile", "storage-state.json")
    expect(existsSync(session), "run: pnpm dev:cli auth twitter").toBe(true)
    // Live create/add/remove is operator-driven via:
    //   pnpm dev:cli auth twitter --create-managed-list
    //   pnpm dev:cli source-list review --dry-run
    //   pnpm dev:cli x-engagement dry-run <run-id>
    if (cfg.twitter.managed_list.list_id) {
      expect(cfg.twitter.managed_list.list_url).toContain(cfg.twitter.managed_list.list_id)
    }
  })

  it("live OHLCV BarProvider returns finalized bars for SOL", async () => {
    const { clearMarketBarPoolCache, createLiveWalletBarProvider } = await import(
      "../../src/orchestrator/market-bars.js"
    )
    clearMarketBarPoolCache()
    const loadBars = createLiveWalletBarProvider(fetch, () => new Date().toISOString())
    const bars = await loadBars({
      schema: 1,
      eventId: "live-ohlcv-1",
      walletId: "w-live",
      chain: "solana",
      tokenAddress: "So11111111111111111111111111111111111111112",
      boughtAt: new Date(Date.now() - 3 * 24 * 3_600_000).toISOString(),
      finalized: true,
      removed: false,
      priceable: true,
      rug: false,
    }, 24)
    expect(bars?.length, "DexScreener+GeckoTerminal should price WSOL").toBeGreaterThan(0)
    expect(bars!.every((b) => b.finalized && Number.isFinite(b.open) && b.open > 0)).toBe(true)
  }, 60_000)

  it("live gate refetch writes a receipt when archive dossier is absent", async () => {
    const { ensureArchive } = await import("../../src/lib/archive.js")
    const { resolveGateArchiveThenLive } = await import(
      "../../src/orchestrator/gate-evidence.js"
    )
    const root = mkdtempSync(join(tmpdir(), "tc-live-gate-"))
    try {
      const layout = await ensureArchive(join(root, "archive"))
      const runId = "live-gate-1"
      mkdirSync(join(layout.runs, runId, "inbox"), { recursive: true })
      const gate = await resolveGateArchiveThenLive({
        layout,
        runId,
        proposal: {
          schema: 1,
          proposalId: "p-live",
          runId,
          proposedAt: new Date().toISOString(),
          provenanceIds: ["live:probe"],
          card: {
            decisionId: "d-live",
            runId,
            decisionTs: new Date().toISOString(),
            verdict: "track",
            identity: {
              chain: "solana",
              tokenAddress: "So11111111111111111111111111111111111111112",
              pairAddress: "So11111111111111111111111111111111111111112",
              symbolDisplay: "SOL",
              resolution: "resolved",
            },
            thesis: "live probe",
            horizonHours: 72,
            invalidation: "n/a",
            drivers: ["social"],
            confidence: 50,
            signalUse: {},
            sources: ["live:probe"],
            clusters: 1,
            countercase: "n/a",
            gate: "pending",
          },
          externalEffects: [],
        },
        nowIso: new Date().toISOString(),
        enableLiveRefetch: true,
      })
      expect(gate).toBeDefined()
      expect(gate?.receipt.source).toBe("live-refetch")
      expect(["pass", "hard-fail", "pending", "unsupported-chain"]).toContain(gate?.status)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe.runIf(!live)("live e2e placeholder", () => {
  it("skips when TRENCHCOAT_LIVE_E2E is not set", () => {
    expect(live).toBe(false)
  })
})

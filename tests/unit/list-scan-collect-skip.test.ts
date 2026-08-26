import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFileSync as readSeed } from "node:fs"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { collectForJob } from "../../src/orchestrator/collect.js"
import { ConfigSchema } from "../../src/lib/config.js"
import { migrateConfigToV29 } from "../../src/migrations/config.js"

const NOW = "2026-07-23T12:00:00.000Z"
const TOKEN = "EN2nnxrg8uUi6x2sJkzNPd2eT6rB9rdSoQNNaENA4RZA"
const PAIR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
const WSOL = "So11111111111111111111111111111111111111112"

const seed = JSON.parse(
  readSeed(join(process.cwd(), "config/seed.example.json"), "utf8"),
) as Record<string, unknown>

function feedConfig(overrides?: Record<string, unknown>) {
  const raw = structuredClone(seed) as Record<string, unknown>
  raw["new_pools_feed"] = {
    enabled: true,
    shadow_mode: false,
    chains: ["solana"],
    gecko_page: 1,
    max_candidates_per_run: 40,
    max_enqueues_per_run: 3,
    max_enqueues_per_day: 5,
    min_pool_age_minutes: 15,
    max_pool_age_hours: 24,
    ...overrides,
  }
  return ConfigSchema.parse(migrateConfigToV29(raw))
}

let activeConfig = feedConfig({ enabled: false })

vi.mock("../../src/lib/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/config.js")>()
  return {
    ...actual,
    loadConfig: () => activeConfig,
  }
})

function mockFetcher() {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes("/new_pools")) {
      return new Response(JSON.stringify({
        data: [{
          id: `solana_${PAIR}`,
          attributes: {
            address: PAIR,
            name: "TEST / SOL",
            pool_created_at: "2026-07-23T11:00:00.000Z",
          },
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.includes("dexscreener.com")) {
      return new Response(JSON.stringify({
        pairs: [{
          chainId: "solana",
          pairAddress: PAIR,
          baseToken: { address: TOKEN, symbol: "TEST", name: "Test" },
          quoteToken: { address: WSOL, symbol: "SOL", name: "Wrapped SOL" },
          liquidity: { usd: 80_000 },
          fdv: 400_000,
          url: "https://dexscreener.com/solana/pair",
          txns: { h24: { buys: 100, sells: 100 } },
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.includes("rugcheck")) {
      return new Response(JSON.stringify({
        mintAuthority: null,
        freezeAuthority: null,
        lpLockedPct: 0.9,
        top10HolderPercent: 0.2,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("missing", { status: 404 })
  })
}

describe("list-scan collect skipAgent", () => {
  beforeEach(() => {
    activeConfig = feedConfig({ enabled: false })
  })

  afterEach(() => {
    activeConfig = feedConfig({ enabled: false })
  })

  it("sets skipAgent when no posts and no agent-alpha paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-ls-skip-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "alpha-queue"), { recursive: true })
    mkdirSync(join(agentRoot, "state", "research"), { recursive: true })
    const writer = new SnapshotWriter(agentRoot)
    const runId = "list-scan-2026-07-23T12-00-00-000Z"
    const summary = await collectForJob({
      job: "list-scan",
      runId,
      writer,
      fetchedAt: NOW,
      agentRoot,
      archiveRoot: join(root, "archive"),
      listScanOverride: {
        bundles: [],
        includeAlphaManifest: true,
      },
    })
    expect(summary.postCount).toBe(0)
    expect(summary.skipAgent).toBe(true)
    expect(summary.collectionStatus).toContain("no-signal")
    expect(summary.agentAlphaPathCount ?? 0).toBe(0)
  })

  it("still collects new-pools on empty FYP when feed is enabled", async () => {
    activeConfig = feedConfig({ enabled: true })
    const root = mkdtempSync(join(tmpdir(), "tc-ls-np-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "alpha-queue"), { recursive: true })
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    mkdirSync(join(root, "archive"), { recursive: true })
    const writer = new SnapshotWriter(agentRoot)
    const runId = "list-scan-2026-07-23T12-00-00-001Z"
    const summary = await collectForJob({
      job: "list-scan",
      runId,
      writer,
      fetchedAt: NOW,
      agentRoot,
      archiveRoot: join(root, "archive"),
      listScanOverride: {
        bundles: [],
        includeAlphaManifest: true,
      },
      fetcher: mockFetcher(),
    })
    expect(summary.postCount).toBe(0)
    expect(summary.skipAgent).toBe(true)
    expect(summary.newPoolsSurvivors?.length).toBe(1)
    expect(summary.snapshotNames).toContain("list-scan-new-pools")
    expect(summary.collectionStatus).toContain("new-pools:survivors=1")
    expect(existsSync(join(
      agentRoot,
      "inbox",
      runId,
      "list-scan-new-pools.json",
    ))).toBe(true)
  })
})

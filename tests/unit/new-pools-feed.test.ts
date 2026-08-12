import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFileSync as readSeed } from "node:fs"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { ConfigSchema, securityThresholdsFromConfig } from "../../src/lib/config.js"
import { migrateConfigToV26 } from "../../src/migrations/config.js"
import type { MarketPair } from "../../src/collectors/market/providers.js"
import type { NewPoolsFeedItem } from "../../src/contracts/schemas.js"
import {
  collectNewPoolsFeed,
  filterNewPoolCandidate,
  pickNonNativeToken,
  sortNewPoolCandidates,
  type NewPoolResolvedCandidate,
} from "../../src/orchestrator/new-pools-feed.js"

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
  return ConfigSchema.parse(migrateConfigToV26(raw))
}

let activeConfig = feedConfig()

vi.mock("../../src/lib/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/config.js")>()
  return {
    ...actual,
    loadConfig: () => activeConfig,
    securityThresholdsFromConfig: actual.securityThresholdsFromConfig,
  }
})

function pair(partial?: Partial<MarketPair>): MarketPair {
  return {
    chainId: "solana",
    pairAddress: PAIR,
    baseToken: {
      address: TOKEN,
      symbol: "TEST",
      name: "Test Token",
    },
    quoteToken: {
      address: WSOL,
      symbol: "SOL",
      name: "Wrapped SOL",
    },
    liquidityUsd: 80_000,
    fdv: 400_000,
    buys24h: 100,
    sells24h: 100,
    url: "https://dexscreener.com/solana/pair",
    ...partial,
  }
}

function resolved(
  partial?: Partial<NewPoolResolvedCandidate>,
): NewPoolResolvedCandidate {
  const p = pair()
  return {
    chain: "solana",
    tokenAddress: TOKEN,
    pairAddress: PAIR,
    symbolDisplay: "TEST",
    poolCreatedAt: "2026-07-23T11:00:00.000Z",
    poolAgeMinutes: 60,
    liquidityUsd: 80_000,
    pair: p,
    provenance: `feed:new-pools:gecko:solana:${PAIR}`,
    poolAddress: PAIR,
    ...partial,
  }
}

function geckoBody(createdAt?: string) {
  return JSON.stringify({
    data: [{
      id: `solana_${PAIR}`,
      attributes: {
        address: PAIR,
        name: "TEST / SOL",
        ...(createdAt ? { pool_created_at: createdAt } : {}),
      },
    }],
  })
}

function dexBody(p: MarketPair = pair()) {
  return JSON.stringify({
    pairs: [{
      chainId: p.chainId,
      pairAddress: p.pairAddress,
      baseToken: p.baseToken,
      quoteToken: p.quoteToken,
      liquidity: { usd: p.liquidityUsd },
      fdv: p.fdv,
      url: p.url,
      txns: { h24: { buys: p.buys24h, sells: p.sells24h } },
    }],
  })
}

function rugcheckPass() {
  return JSON.stringify({
    mintAuthority: null,
    freezeAuthority: null,
    lpLockedPct: 0.9,
    top10HolderPercent: 0.2,
  })
}

describe("new-pools-feed filters", () => {
  it("picks the non-native side of a pair", () => {
    const flipped = pair({
      baseToken: { address: WSOL, symbol: "SOL", name: "Wrapped SOL" },
      quoteToken: { address: TOKEN, symbol: "TEST", name: "Test Token" },
    })
    expect(pickNonNativeToken(flipped)?.address).toBe(TOKEN)
  })

  it("rejects unknown createdAt as pool-too-young", () => {
    const base = resolved()
    const { poolAgeMinutes: _age, poolCreatedAt: _created, ...withoutAge } = base
    const decision = filterNewPoolCandidate({
      candidate: withoutAge,
      minPoolAgeMinutes: 15,
      maxPoolAgeHours: 24,
      seenKeys: new Set(),
      watchlistKeys: new Set(),
      queueKeys: new Set(),
      securityStatus: "pass",
      securityFlags: [],
      marketQualityStatus: "pass",
      marketQualityReasons: [],
    })
    expect(decision.status).toBe("reject")
    if (decision.status === "reject") expect(decision.reason).toBe("pool-too-young")
  })

  it("rejects security hard-fail and pending", () => {
    for (const securityStatus of ["fail", "pending"] as const) {
      const decision = filterNewPoolCandidate({
        candidate: resolved(),
        minPoolAgeMinutes: 15,
        maxPoolAgeHours: 24,
        seenKeys: new Set(),
        watchlistKeys: new Set(),
        queueKeys: new Set(),
        securityStatus,
        securityFlags: securityStatus === "fail" ? ["honeypot"] : [],
        marketQualityStatus: "pass",
        marketQualityReasons: [],
      })
      expect(decision.status).toBe("reject")
    }
  })

  it("keeps market-quality failures when security passes", () => {
    const decision = filterNewPoolCandidate({
      candidate: resolved(),
      minPoolAgeMinutes: 15,
      maxPoolAgeHours: 24,
      seenKeys: new Set(),
      watchlistKeys: new Set(),
      queueKeys: new Set(),
      securityStatus: "pass",
      securityFlags: [],
      marketQualityStatus: "fail",
      marketQualityReasons: ["liquidity"],
    })
    expect(decision.status).toBe("accept")
    if (decision.status === "accept") {
      expect(decision.item.marketQualityStatus).toBe("fail")
    }
  })

  it("sorts market-quality pass first, then liquidity, then younger", () => {
    const items: NewPoolsFeedItem[] = [
      {
        chain: "solana",
        tokenAddress: "Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
        pairAddress: PAIR,
        liquidityUsd: 90_000,
        poolAgeMinutes: 120,
        securityStatus: "pass",
        securityFlags: [],
        marketQualityStatus: "fail",
        marketQualityReasons: ["liquidity"],
        provenance: "a",
      },
      {
        chain: "solana",
        tokenAddress: "Bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2",
        pairAddress: PAIR,
        liquidityUsd: 50_000,
        poolAgeMinutes: 30,
        securityStatus: "pass",
        securityFlags: [],
        marketQualityStatus: "pass",
        marketQualityReasons: [],
        provenance: "b",
      },
      {
        chain: "solana",
        tokenAddress: "Cccccccccccccccccccccccccccccccccccccccc3",
        pairAddress: PAIR,
        liquidityUsd: 70_000,
        poolAgeMinutes: 40,
        securityStatus: "pass",
        securityFlags: [],
        marketQualityStatus: "pass",
        marketQualityReasons: [],
        provenance: "c",
      },
    ]
    const sorted = sortNewPoolCandidates(items)
    expect(sorted.map((i) => i.provenance)).toEqual(["c", "b", "a"])
  })
})

describe("collectNewPoolsFeed", () => {
  beforeEach(() => {
    activeConfig = feedConfig()
  })

  afterEach(() => {
    activeConfig = feedConfig()
  })

  it("returns empty when disabled", async () => {
    activeConfig = feedConfig({ enabled: false })
    const root = mkdtempSync(join(tmpdir(), "tc-npf-off-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    const result = await collectNewPoolsFeed({
      runId: "list-scan-2026-07-23T12-00-00-000Z",
      writer: new SnapshotWriter(agentRoot),
      fetchedAt: NOW,
      agentRoot,
      archiveRoot: join(root, "archive"),
      fetcher: async () => {
        throw new Error("should not fetch")
      },
    })
    expect(result.survivors).toEqual([])
    expect(result.statusLines).toContain("new-pools:disabled")
  })

  it("accepts a safe pool and logs rejects for hard-fail", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-npf-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    mkdirSync(archiveRoot, { recursive: true })

    const createdAt = "2026-07-23T11:00:00.000Z"
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes("/new_pools")) {
        return new Response(geckoBody(createdAt), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("dexscreener.com")) {
        return new Response(dexBody(), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("rugcheck")) {
        return new Response(rugcheckPass(), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response("missing", { status: 404 })
    })

    const result = await collectNewPoolsFeed({
      runId: "list-scan-2026-07-23T12-00-00-000Z",
      writer: new SnapshotWriter(agentRoot),
      fetchedAt: NOW,
      agentRoot,
      archiveRoot,
      fetcher,
    })

    expect(result.survivors).toHaveLength(1)
    expect(result.survivors[0]?.tokenAddress).toBe(TOKEN)
    expect(result.snapshotName).toBe("list-scan-new-pools")
    expect(existsSync(join(
      agentRoot,
      "inbox",
      "list-scan-2026-07-23T12-00-00-000Z",
      "list-scan-new-pools.json",
    ))).toBe(true)

    const logPath = join(archiveRoot, "discovery-log.jsonl")
    expect(existsSync(logPath)).toBe(true)
    const lines = readFileSync(logPath, "utf8").trim().split("\n")
    expect(lines.some((line) => line.includes("candidate-accepted"))).toBe(true)

    // Thresholds still load from mocked config
    expect(securityThresholdsFromConfig(activeConfig).liquidityFloorUsd).toBeGreaterThan(0)
  })

  it("rejects missing pool_created_at fail-closed", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-npf-age-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    mkdirSync(archiveRoot, { recursive: true })

    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes("/new_pools")) {
        return new Response(geckoBody(undefined), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("dexscreener.com")) {
        return new Response(dexBody(), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("rugcheck")) {
        return new Response(rugcheckPass(), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response("missing", { status: 404 })
    })

    const result = await collectNewPoolsFeed({
      runId: "list-scan-2026-07-23T12-00-00-000Z",
      writer: new SnapshotWriter(agentRoot),
      fetchedAt: NOW,
      agentRoot,
      archiveRoot,
      fetcher,
    })
    expect(result.survivors).toHaveLength(0)
    expect(result.rejected.some((r) => r.reason === "pool-too-young")).toBe(true)
  })
})

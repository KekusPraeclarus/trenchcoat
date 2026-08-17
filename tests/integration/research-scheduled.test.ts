import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigSchema } from "../../src/lib/config.js"
import { migrateConfigToV28 } from "../../src/migrations/config.js"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import type { ResearchQueueEntry, ResearchQueueFile } from "../../src/contracts/schemas.js"

const SOL = "So11111111111111111111111111111111111111112"
const PAIR = "7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm"

function writeMinimalConfig(dir: string): void {
  const cfg = ConfigSchema.parse(migrateConfigToV28({
    schema: 5,
    twitter: {
      operator_list_urls: [
        "https://x.com/i/lists/1",
        "https://x.com/i/lists/2",
      ],
      managed_list: {
        name: "trenchcoat-sources",
        description: "Sources promoted by trenchcoat",
        capacity: 250,
      },
      source_lifecycle: {
        promotion: {},
        demotion: {},
      },
      engagement: {},
    },
    research: {
      daily_cap: 3,
      web_search: { enabled: false },
      twitter_search: { enabled: false },
      farcaster_search: { enabled: false },
    },
    broadcast: {},
    indicators: {},
    gate_thresholds: {},
    audit: { rsi_promotion: {} },
    wallets: {
      deterministic_weight: 0.8,
      llm_weight: 0.2,
      promotion: {},
      drop: {},
    },
    source_safety: {},
    retention: {},
    chat: { research_confirm_ttl_minutes: 15 },
    router: {},
    harness_improvement: {},
  }))
  mkdirSync(join(dir, ".trenchcoat"), { recursive: true })
  writeFileSync(join(dir, ".trenchcoat", "config.json"), `${JSON.stringify(cfg, null, 2)}\n`)
}

function queueEntry(
  partial: Partial<ResearchQueueEntry> & Pick<ResearchQueueEntry, "queueId" | "subject">,
  nowIso: string,
): ResearchQueueEntry {
  return {
    schema: 1,
    priority: 50,
    firstSeen: nowIso,
    enqueuedAt: nowIso,
    enqueuedBy: "test",
    expiresAt: new Date(Date.parse(nowIso) + 7 * 86_400_000).toISOString(),
    provenance: ["test:fixture"],
    clusterCount: 1,
    security: { status: "pending", flags: [] },
    status: "pending",
    resolution: "pending",
    reason: "test",
    trigger: "social",
    ...partial,
  }
}

function scaffoldWorkspace(): { home: string; agentRoot: string; archiveRoot: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tc-research-sched-")))
  const home = join(root, "home")
  const agentRoot = join(root, "agent")
  const archiveRoot = join(root, "archive")
  mkdirSync(join(agentRoot, "state"), { recursive: true })
  mkdirSync(join(agentRoot, "inbox"), { recursive: true })
  mkdirSync(join(agentRoot, "reports"), { recursive: true })
  mkdirSync(join(agentRoot, "outbox"), { recursive: true })
  mkdirSync(join(agentRoot, "alpha-queue"), { recursive: true })
  writeFileSync(join(agentRoot, "state", "watchlist.json"), `${JSON.stringify({ schema: 1, entries: [] }, null, 2)}\n`)
  writeFileSync(join(agentRoot, "state", "sources.json"), `${JSON.stringify({ schema: 1, accounts: [] }, null, 2)}\n`)
  writeFileSync(join(agentRoot, "state", "ledger.json"), `${JSON.stringify({ schema: 1, positions: [] }, null, 2)}\n`)
  writeFileSync(join(agentRoot, "state", "wallets.json"), `${JSON.stringify({ schema: 1, wallets: [] }, null, 2)}\n`)
  writeFileSync(join(agentRoot, "state", "research-queue.json"), `${JSON.stringify({ schema: 1, entries: [] }, null, 2)}\n`)
  writeFileSync(join(agentRoot, "state", "decisions.md"), "")
  writeFileSync(join(agentRoot, "AGENTS.md"), "# test\n")
  writeMinimalConfig(home)
  return { home, agentRoot, archiveRoot }
}

const dexFetcher: typeof fetch = async (input) => {
  const url = String(input)
  if (url.includes("dexscreener")) {
    return new Response(JSON.stringify({
      pairs: [{
        chainId: "solana",
        pairAddress: PAIR,
        baseToken: { address: SOL, symbol: "SOL", name: "Solana" },
        quoteToken: { address: "usd", symbol: "USDC", name: "USDC" },
        priceUsd: "100",
        liquidity: { usd: 1_000_000 },
        volume: { h24: 50_000 },
        txns: { h24: { buys: 10, sells: 5 } },
        fdv: 1_000_000,
        url: "https://dexscreener.com/solana/x",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })
  }
  return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })
}

describe("scheduled research Phase 1A", () => {
  it("empty queue skips collector and agent with no run dirs", async () => {
    const { home, agentRoot, archiveRoot } = scaffoldWorkspace()
    const prevHome = process.env["HOME"]
    process.env["HOME"] = home
    vi.resetModules()

    try {
      const { runJob } = await import("../../src/orchestrator/run.js")
      const result = await runJob({
        job: "research",
        paths: { agentRoot, archiveRoot },
        skipAgent: true,
      })
      expect(result.exitCode).toBe(0)
      expect(result.runId).toBe("none")
      expect(readdirSync(join(agentRoot, "inbox"))).toHaveLength(0)
      expect(readdirSync(join(agentRoot, "reports"))).toHaveLength(0)
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
    }
  }, 15_000)

  it("daily-cap exhaustion skips without consuming a run", async () => {
    const { home, agentRoot, archiveRoot } = scaffoldWorkspace()
    const day = new Date().toISOString().slice(0, 10)
    const nowIso = `${day}T12:00:00.000Z`
    const capped: ResearchQueueFile = {
      schema: 1,
      entries: [
        queueEntry({ queueId: "rq-blocked", subject: "BONK" }, nowIso),
      ],
      completedToday: { day, count: 3 },
    }
    writeFileSync(join(agentRoot, "state", "research-queue.json"), `${JSON.stringify(capped, null, 2)}\n`)

    const prevHome = process.env["HOME"]
    process.env["HOME"] = home
    vi.resetModules()

    try {
      const { runJob } = await import("../../src/orchestrator/run.js")
      const result = await runJob({
        job: "research",
        paths: { agentRoot, archiveRoot },
        skipAgent: true,
      })
      expect(result.exitCode).toBe(0)
      expect(result.runId).toBe("none")
      const queue = JSON.parse(
        readFileSync(join(agentRoot, "state", "research-queue.json"), "utf8"),
      ) as ResearchQueueFile
      expect(queue.entries[0]?.status).toBe("pending")
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
    }
  }, 15_000)

  it("bound subject collects full dossier before agent", async () => {
    const { home, agentRoot, archiveRoot } = scaffoldWorkspace()
    const prevHome = process.env["HOME"]
    process.env["HOME"] = home
    vi.resetModules()

    try {
      const { collectForJob } = await import("../../src/orchestrator/collect.js")
      const runId = "research-dossier-1"
      const result = await collectForJob({
        job: "research",
        runId,
        writer: new SnapshotWriter(agentRoot),
        fetchedAt: new Date().toISOString(),
        agentRoot,
        archiveRoot,
        researchSubject: {
          queueId: "rq-bound",
          subject: `solana:${SOL}`,
          chain: "solana",
          tokenAddress: SOL,
        },
        fetcher: dexFetcher,
      })

      expect(result.researchResolution).toBe("resolved")
      expect(result.skipAgent).not.toBe(true)
      expect(result.snapshotNames).toEqual(expect.arrayContaining([
        "meta",
        "market-dex",
        "security-gate",
      ]))
      expect(existsSync(join(agentRoot, "inbox", runId, "meta.json"))).toBe(true)
      expect(existsSync(join(agentRoot, "inbox", runId, "market-dex.json"))).toBe(true)
      expect(existsSync(join(agentRoot, "inbox", runId, "security-gate.json"))).toBe(true)
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
    }
  })
})

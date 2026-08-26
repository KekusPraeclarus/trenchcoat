import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFileSync as readSeed } from "node:fs"
import { ConfigSchema } from "../../src/lib/config.js"
import { migrateConfigToV29 } from "../../src/migrations/config.js"
import { archiveLayout, ensureArchive } from "../../src/lib/archive.js"
import { StateStore } from "../../src/lib/state.js"
import {
  enqueueNewPoolsResearch,
  newPoolsDailyCount,
} from "../../src/orchestrator/new-pools-enqueue.js"
import type { NewPoolsFeedItem } from "../../src/contracts/schemas.js"

const NOW = "2026-07-23T12:00:00.000Z"
const TOKEN_A = "EN2nnxrg8uUi6x2sJkzNPd2eT6rB9rdSoQNNaENA4RZA"
const TOKEN_B = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
const TOKEN_C = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const TOKEN_D = "Es9vMFrzaCERmJfrF4H31FYECkRBGZrrfJScGu9xAqzG"
const PAIR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"

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

let activeConfig = feedConfig()

vi.mock("../../src/lib/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/config.js")>()
  return {
    ...actual,
    loadConfig: () => activeConfig,
  }
})

function survivor(
  tokenAddress: string,
  mq: "pass" | "fail" = "pass",
): NewPoolsFeedItem {
  return {
    chain: "solana",
    tokenAddress,
    pairAddress: PAIR,
    symbolDisplay: "TEST",
    poolAgeMinutes: 60,
    liquidityUsd: 80_000,
    securityStatus: "pass",
    securityFlags: [],
    marketQualityStatus: mq,
    marketQualityReasons: mq === "fail" ? ["liquidity"] : [],
    provenance: `feed:new-pools:gecko:solana:${PAIR}`,
  }
}

describe("enqueueNewPoolsResearch", () => {
  beforeEach(() => {
    activeConfig = feedConfig()
  })

  afterEach(() => {
    activeConfig = feedConfig()
  })

  it("enqueues with trigger new-pools priority 40 and writes receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-npe-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    const layout = await ensureArchive(join(root, "archive"))
    const runId = "list-scan-2026-07-23T12-00-00-000Z"

    const result = await enqueueNewPoolsResearch({
      agentRoot,
      layout,
      runId,
      nowIso: NOW,
      survivors: [survivor(TOKEN_A, "fail")],
    })

    expect(result.accepted).toBe(1)
    expect(result.shadowMode).toBe(false)
    const state = new StateStore(join(agentRoot, "state"))
    const queue = state.loadResearchQueue()
    expect(queue.entries).toHaveLength(1)
    expect(queue.entries[0]?.trigger).toBe("new-pools")
    expect(queue.entries[0]?.priority).toBe(40)
    expect(queue.entries[0]?.resolution).toBe("resolved")
    expect(queue.entries[0]?.security.status).toBe("pass")
    expect(queue.entries[0]?.reason).toContain("mq-fail")

    expect(existsSync(join(
      layout.runs,
      runId,
      "new-pools-enqueue-receipt.json",
    ))).toBe(true)
    expect(existsSync(join(
      agentRoot,
      "reports",
      runId,
      "new-pools-enqueue-receipt.json",
    ))).toBe(true)
    expect(await newPoolsDailyCount(layout.root, "2026-07-23")).toBe(1)

    const log = readFileSync(join(layout.root, "discovery-log.jsonl"), "utf8")
    expect(log).toContain("\"reason\":\"enqueued\"")
  })

  it("honors shadow_mode: receipt and log, no queue write", async () => {
    activeConfig = feedConfig({ shadow_mode: true })
    const root = mkdtempSync(join(tmpdir(), "tc-npe-shadow-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    const layout = await ensureArchive(join(root, "archive"))
    const runId = "list-scan-2026-07-23T12-00-00-001Z"

    const result = await enqueueNewPoolsResearch({
      agentRoot,
      layout,
      runId,
      nowIso: NOW,
      survivors: [survivor(TOKEN_A)],
    })

    expect(result.accepted).toBe(1)
    expect(result.shadowMode).toBe(true)
    const state = new StateStore(join(agentRoot, "state"))
    expect(state.loadResearchQueue().entries).toHaveLength(0)
    expect(await newPoolsDailyCount(layout.root, "2026-07-23")).toBe(0)
    expect(existsSync(join(
      layout.runs,
      runId,
      "new-pools-enqueue-receipt.json",
    ))).toBe(true)
  })

  it("caps at 3 per run and 5 per day", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-npe-cap-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    const layout = await ensureArchive(join(root, "archive"))
    const runId = "list-scan-2026-07-23T12-00-00-002Z"

    const four = [TOKEN_A, TOKEN_B, TOKEN_C, TOKEN_D].map((t) => survivor(t))
    const first = await enqueueNewPoolsResearch({
      agentRoot,
      layout,
      runId,
      nowIso: NOW,
      survivors: four,
    })
    expect(first.accepted).toBe(3)
    expect(first.rejected).toBe(1)

    mkdirSync(join(layout.root, "provider-usage", "new-pools"), {
      recursive: true,
    })
    writeFileSync(
      join(layout.root, "provider-usage", "new-pools", "enqueues-2026-07-23.json"),
      `${JSON.stringify({ schema: 1, day: "2026-07-23", count: 5 })}\n`,
    )

    const second = await enqueueNewPoolsResearch({
      agentRoot,
      layout,
      runId: "list-scan-2026-07-23T12-00-00-003Z",
      nowIso: NOW,
      survivors: [survivor(TOKEN_D)],
    })
    expect(second.accepted).toBe(0)
    expect(second.receipt.rejected[0]?.reason).toBe("daily-cap")
  })

  it("dedupes via existing queue key", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-npe-dedupe-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    const layout = archiveLayout(join(root, "archive"))
    await ensureArchive(layout.root)
    const runId = "list-scan-2026-07-23T12-00-00-004Z"

    await enqueueNewPoolsResearch({
      agentRoot,
      layout,
      runId,
      nowIso: NOW,
      survivors: [survivor(TOKEN_A)],
    })
    await enqueueNewPoolsResearch({
      agentRoot,
      layout,
      runId: "list-scan-2026-07-23T12-00-00-005Z",
      nowIso: NOW,
      survivors: [survivor(TOKEN_A)],
    })

    const state = new StateStore(join(agentRoot, "state"))
    expect(state.loadResearchQueue().entries).toHaveLength(1)
  })
})

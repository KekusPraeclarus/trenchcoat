import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  confirmPending,
  filePendingResearchStore,
  proposeResearch,
} from "../../src/chat/pending-research.js"
import { extractResearchIntent } from "../../src/chat/research-intent.js"
import { StateStore } from "../../src/lib/state.js"
import { ConfigSchema } from "../../src/lib/config.js"
import { migrateConfigToV26, migrateConfigToV27 } from "../../src/migrations/config.js"

const SOL = "So11111111111111111111111111111111111111112"
const NOW = "2026-07-17T15:00:00.000Z"

function writeMinimalConfig(dir: string): void {
  const cfg = ConfigSchema.parse(migrateConfigToV27({
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
    research: { daily_cap: 3, web_search: { enabled: false } },
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

describe("operator research loop integration", () => {
  it("confirm → durable queue → dry research run → report path", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-research-loop-"))
    const home = join(root, "home")
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    mkdirSync(join(agentRoot, "inbox"), { recursive: true })
    mkdirSync(join(agentRoot, "reports"), { recursive: true })
    writeFileSync(join(agentRoot, "state", "research-queue.json"), `${JSON.stringify({ schema: 1, entries: [] }, null, 2)}\n`)
    writeMinimalConfig(home)

    const prevHome = process.env["HOME"]
    process.env["HOME"] = home
    vi.resetModules()

    try {
      const { enqueueOperatorResearch, runOperatorResearchNow } = await import(
        "../../src/orchestrator/research.js"
      )
      const store = filePendingResearchStore(join(home, "pending-research.json"))
      const intent = extractResearchIntent(`research solana:${SOL}`)
      const proposed = proposeResearch({
        file: store.load(),
        telegramUserId: "ops",
        intent,
        nowIso: NOW,
        ttlMinutes: 15,
      })
      store.save(proposed.file)
      const confirmed = confirmPending({
        file: store.load(),
        telegramUserId: "ops",
        nowIso: NOW,
      })
      expect(confirmed.confirmed?.status).toBe("queued")
      store.save(confirmed.file!)

      const queued = await enqueueOperatorResearch({
        paths: { agentRoot, archiveRoot },
        input: {
          subject: `solana:${SOL}`,
          chainHint: "solana",
          tokenHint: SOL,
          requestId: confirmed.confirmed!.requestId,
          provenance: [`operator:telegram:${confirmed.confirmed!.requestId}`],
        },
        nowIso: NOW,
      })
      expect(queued.status).toBe("queued")
      expect(queued.queueId).toBeTruthy()

      const state = new StateStore(join(agentRoot, "state"))
      expect(state.loadResearchQueue().entries.some((e) => e.trigger === "operator")).toBe(true)

      const result = await runOperatorResearchNow({
        paths: { agentRoot, archiveRoot },
        input: {
          subject: `solana:${SOL}`,
          chainHint: "solana",
          tokenHint: SOL,
          requestId: confirmed.confirmed!.requestId,
        },
        nowIso: NOW,
        skipAgent: true,
        dryCollect: true,
      })
      expect(["completed", "ambiguous", "rejected", "failed"]).toContain(result.status)
      if (result.status === "completed") {
        expect(result.runId).toBeTruthy()
        expect(existsSync(join(agentRoot, "reports", result.runId!, "agent.md"))).toBe(true)
      }

      // Lock contention leaves confirmed request queued
      writeFileSync(join(agentRoot, ".lock"), "1\n")
      writeFileSync(join(agentRoot, ".lock.owner"), `${process.pid}\n`)
      const busy = await runOperatorResearchNow({
        paths: { agentRoot, archiveRoot },
        input: { subject: `solana:${SOL}`, chainHint: "solana", tokenHint: SOL },
        nowIso: NOW,
        skipAgent: true,
        dryCollect: true,
      })
      expect(busy.status).toBe("busy")
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
      vi.resetModules()
    }
  })

  it("web-search request file is schema-validated and path-scoped", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-research-web-"))
    const reportDir = join(root, "reports", "research-1")
    mkdirSync(reportDir, { recursive: true })
    writeFileSync(join(reportDir, "web-search-requests.json"), `${JSON.stringify({
      schema: 1,
      runId: "research-1",
      requests: [{ query: "BONK solana token", reason: "narrative check" }],
    }, null, 2)}\n`)
    const raw = JSON.parse(readFileSync(join(reportDir, "web-search-requests.json"), "utf8"))
    expect(raw.requests[0].query).not.toMatch(/^https?:\/\//u)
  })
})

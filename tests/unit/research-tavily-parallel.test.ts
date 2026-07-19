import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const searchTavilyWeb = vi.fn()
const runOneShotSession = vi.fn()

vi.mock("../../src/collectors/web/tavily.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/collectors/web/tavily.js")>()
  return {
    ...actual,
    searchTavilyWeb: (...args: unknown[]) => searchTavilyWeb(...args),
  }
})

vi.mock("../../src/orchestrator/session.js", () => ({
  runOneShotSession: (...args: unknown[]) => runOneShotSession(...args),
}))

vi.mock("../../src/lib/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/config.js")>()
  return {
    ...actual,
    loadConfig: () => ({
      ...actual.loadConfig(),
      research: {
        ...actual.loadConfig().research,
        web_search: { enabled: true, max_queries_per_run: 3 },
      },
    }),
  }
})

import { runResearchPasses } from "../../src/orchestrator/research.js"

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("research tavily concurrency", () => {
  const prevKey = process.env["TAVILY_API_KEY"]
  let root = ""

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tc-tavily-par-"))
    process.env["TAVILY_API_KEY"] = "test-key"
    searchTavilyWeb.mockReset()
    runOneShotSession.mockReset()
  })

  afterEach(() => {
    if (prevKey === undefined) delete process.env["TAVILY_API_KEY"]
    else process.env["TAVILY_API_KEY"] = prevKey
    rmSync(root, { recursive: true, force: true })
  })

  it("runs queries concurrently with stable index names and isolates failures", async () => {
    const runId = "research-web-1"
    const reportDir = join(root, "reports", runId)
    mkdirSync(reportDir, { recursive: true })

    let inFlight = 0
    let maxInFlight = 0
    searchTavilyWeb.mockImplementation(async (args: { query: string }) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await delay(60)
      inFlight -= 1
      if (args.query.includes("fail")) throw new Error("upstream")
      return {
        query: args.query,
        hits: [{
          title: "hit",
          url: "https://example.com/a",
          description: "ok",
        }],
      }
    })

    runOneShotSession.mockImplementation(async (args: { prompt: string }) => {
      if (args.prompt.includes("agent-pass1.md")) {
        writeFileSync(
          join(reportDir, "web-search-requests.json"),
          JSON.stringify({
            schema: 1,
            runId,
            requests: [
              { query: "token liquidity", reason: "market" },
              { query: "token fail case", reason: "neg" },
              { query: "token team", reason: "team" },
            ],
          }),
        )
        return { status: "ok", text: "pass1 notes" }
      }
      return { status: "ok", text: "final report" }
    })

    const started = Date.now()
    await runResearchPasses({
      agentRoot: root,
      runId,
      subject: "solana:So11111111111111111111111111111111111111112",
      identity: {
        chain: "solana",
        tokenAddress: "So11111111111111111111111111111111111111112",
        pairAddress: "pair",
        symbolDisplay: "SOL",
        resolution: "resolved",
      },
    })
    const elapsed = Date.now() - started

    expect(searchTavilyWeb).toHaveBeenCalledTimes(3)
    expect(maxInFlight).toBeGreaterThan(1)
    // Concurrent 60ms waits should finish well under serial 180ms; leave headroom
    expect(elapsed).toBeLessThan(450)
    expect(existsSync(join(root, "inbox", runId, "web-tavily-0.json"))).toBe(true)
    expect(existsSync(join(root, "inbox", runId, "web-tavily-2.json"))).toBe(true)
    expect(existsSync(join(root, "inbox", runId, "web-tavily-1.json"))).toBe(false)

    const snap0 = JSON.parse(
      readFileSync(join(root, "inbox", runId, "web-tavily-0.json"), "utf8"),
    ) as { items: Array<{ text: string }> }
    expect(snap0.items.length).toBeGreaterThan(0)
    expect(existsSync(join(reportDir, "agent.md"))).toBe(true)
    expect(runOneShotSession).toHaveBeenCalledTimes(2)
  })
})

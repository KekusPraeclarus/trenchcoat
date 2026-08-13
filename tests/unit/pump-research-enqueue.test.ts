import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigSchema, type TrenchcoatConfig } from "../../src/lib/config.js"
import { enqueuePumpResearch } from "../../src/orchestrator/pump-collect.js"
import { StateStore } from "../../src/lib/state.js"
import type { PumpFeedItem } from "../../src/collectors/pump/types.js"

const MINT_FOLLOW = "EN2nnxrg8uUi6x2sJkzNPd2eT6rB9rdSoQNNaENA4RZA"
const MINT_TOP = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
const WRAP = "So11111111111111111111111111111111111111112"
const NOW = "2026-08-13T12:00:00.000Z"
const seed = JSON.parse(
  readFileSync(join(process.cwd(), "config/seed.example.json"), "utf8"),
) as Record<string, unknown>

function pumpConfig(max = 3): TrenchcoatConfig {
  const base = ConfigSchema.parse(seed)
  return {
    ...base,
    pump: {
      ...base.pump,
      enabled: true,
      shadow_mode: false,
      research: { max_enqueues_per_day: max },
    },
  }
}

function item(tab: PumpFeedItem["tab"], mint: string, id: string): PumpFeedItem {
  return {
    itemId: id,
    author: `${tab}-author`,
    tab,
    mint,
    chain: "solana",
    observedAt: NOW,
  }
}

function dexPair(mint: string) {
  return {
    chainId: "solana",
    pairAddress: "So11111111111111111111111111111111111111112",
    baseToken: { address: mint, symbol: "FOO", name: "Foo" },
    quoteToken: {
      address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      symbol: "USDC",
      name: "USD Coin",
    },
    priceUsd: "1",
    liquidity: { usd: 10_000 },
    volume: { h24: 1_000 },
    fdv: 20_000,
    txns: { h24: { buys: 10, sells: 5 } },
    url: "https://dexscreener.com/solana/pair",
  }
}

function fetcherFor(mints: readonly string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    const hit = mints.find((mint) => url.includes(encodeURIComponent(`solana:${mint}`)) || url.includes(mint))
    if (hit) {
      return new Response(JSON.stringify({ pairs: [dexPair(hit)] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response(JSON.stringify({ pairs: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

describe("pump research enqueue", () => {
  it("prefers Following over Top and skips native wrap", async () => {
    const root = mkdtempSync(join(tmpdir(), "pump-enq-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    await enqueuePumpResearch({
      agentRoot,
      archiveRoot: join(root, "archive"),
      fetchedAt: NOW,
      runId: "pump-scan-1",
      config: pumpConfig(1),
      following: [item("following", MINT_FOLLOW, "f1")],
      top: [item("top", MINT_TOP, "t1"), item("top", WRAP, "wrap")],
      fetcher: fetcherFor([MINT_FOLLOW, MINT_TOP]),
    })
    const queue = new StateStore(join(agentRoot, "state")).loadResearchQueue()
    expect(queue.entries).toHaveLength(1)
    expect(queue.entries[0]?.tokenAddress).toBe(MINT_FOLLOW)
    expect(queue.entries[0]?.enqueuedBy).toBe("pump:following")
  })

  it("skips unresolved DexScreener subjects", async () => {
    const root = mkdtempSync(join(tmpdir(), "pump-enq-empty-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    await enqueuePumpResearch({
      agentRoot,
      archiveRoot: join(root, "archive"),
      fetchedAt: NOW,
      runId: "pump-scan-2",
      config: pumpConfig(3),
      following: [],
      top: [item("top", MINT_TOP, "t1")],
      fetcher: async () => new Response(JSON.stringify({ pairs: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    })
    const queue = new StateStore(join(agentRoot, "state")).loadResearchQueue()
    expect(queue.entries).toHaveLength(0)
  })
})

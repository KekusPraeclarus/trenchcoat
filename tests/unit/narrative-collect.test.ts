import { describe, expect, it, beforeEach } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetRateGatesForTests } from "../../src/lib/rate-gate.js"
import { gatedFetchWithRetry } from "../../src/lib/http.js"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { collectNarrativeScan } from "../../src/orchestrator/narrative-collect.js"
import {
  fetchMarketAttentionForNarrative,
} from "../../src/collectors/market/providers.js"
import type { FetchLike } from "../../src/collectors/market/geckoterminal.js"

const NOW = "2026-07-18T12:00:00.000Z"

describe("gatedFetchWithRetry", () => {
  beforeEach(() => {
    resetRateGatesForTests()
  })

  it("retries 429 then returns success", async () => {
    let calls = 0
    const delays: number[] = []
    const fetcher: FetchLike = async () => {
      calls += 1
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0.01" },
        })
      }
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    const response = await gatedFetchWithRetry(
      fetcher,
      "https://example.test/retry",
      {
        host: "example.test-retry",
        capacity: 10,
        refillPerSecond: 100,
        sleep: async (ms) => { delays.push(ms) },
      },
    )
    expect(response.status).toBe(200)
    expect(calls).toBe(2)
    expect(delays.length).toBe(1)
  })

  it("does not retry ordinary 4xx", async () => {
    let calls = 0
    const fetcher: FetchLike = async () => {
      calls += 1
      return new Response("nope", { status: 400 })
    }
    const response = await gatedFetchWithRetry(
      fetcher,
      "https://example.test/400",
      {
        host: "example.test-400",
        capacity: 10,
        refillPerSecond: 100,
        sleep: async () => undefined,
      },
    )
    expect(response.status).toBe(400)
    expect(calls).toBe(1)
  })

  it("caps attempts on repeated 500", async () => {
    let calls = 0
    const fetcher: FetchLike = async () => {
      calls += 1
      return new Response("boom", { status: 500 })
    }
    const response = await gatedFetchWithRetry(
      fetcher,
      "https://example.test/500",
      {
        host: "example.test-500",
        capacity: 10,
        refillPerSecond: 100,
        maxAttempts: 3,
        sleep: async () => undefined,
      },
    )
    expect(response.status).toBe(500)
    expect(calls).toBe(3)
  })
})

describe("fetchMarketAttentionForNarrative", () => {
  beforeEach(() => {
    resetRateGatesForTests()
  })

  it("falls back to Dex boosts when CoinGecko fails", async () => {
    const fetcher: FetchLike = async (input) => {
      const url = String(input)
      if (url.includes("coingecko")) {
        // Non-retryable so the fallback path is exercised quickly
        return new Response("down", { status: 400 })
      }
      if (url.includes("dexscreener")) {
        return new Response(JSON.stringify([{
          chainId: "solana",
          tokenAddress: "So11111111111111111111111111111111111111112",
          amount: 1,
          totalAmount: 1,
          description: "boosted",
        }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    const result = await fetchMarketAttentionForNarrative(fetcher, { demoKey: "demo" })
    expect(result.marketBlind).toBe(true)
    expect(result.source).toBe("host.market-attention.fallback")
    expect(result.fallbackItems?.some((item) => item.kind === "boost")).toBe(true)
    expect(result.statusLines.some((line) => line.includes("marketBlind=true"))).toBe(true)
  })
})

describe("collectNarrativeScan market-blind", () => {
  it("marks degraded and always writes narrative-trending when CG fails but social exists", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tc-narr-blind-")))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "inbox"), { recursive: true })

    // Minimal sealed list-scan so usableEvidence can come from social
    const { ensureArchive, writeJsonRecordFsync, runArchiveDir } = await import(
      "../../src/lib/archive.js"
    )
    const layout = await ensureArchive(archiveRoot)
    const sealedRunId = "list-scan-2026-07-18T10-00-00-000Z"
    await writeJsonRecordFsync(join(layout.transactions, `${sealedRunId}.json`), {
      schema: 1,
      runId: sealedRunId,
      phase: "complete",
      status: "complete",
      phaseHashes: {},
      sideEffects: {},
    } as never)
    const sealedDir = runArchiveDir(layout, sealedRunId)
    mkdirSync(join(sealedDir, "inbox"), { recursive: true })
    await writeJsonRecordFsync(join(sealedDir, "manifest.json"), {
      schema: 1,
      runId: sealedRunId,
      job: "list-scan",
      createdAt: "2026-07-18T10:00:00.000Z",
      inboxSnapshotNames: ["twitter-fyp"],
    } as never)
    await writeJsonRecordFsync(join(sealedDir, "inbox", "twitter-fyp.json"), {
      source: "host.twitter.fyp",
      fetchedAt: "2026-07-18T10:00:00.000Z",
      trust: "untrusted-external",
      items: [{
        provenance: `${sealedRunId}:tweet:1`,
        text: "base ai agents heating",
        ts: "2026-07-18T10:00:00.000Z",
        ageSec: 0,
        freshnessTier: "live",
      }],
    } as never)

    const writer = new SnapshotWriter(agentRoot)
    const runId = "narrative-scan-2026-07-18T12-00-00-000Z"
    const prev = process.env["COINGECKO_DEMO_KEY"]
    process.env["COINGECKO_DEMO_KEY"] = "demo-key"
    try {
      const result = await collectNarrativeScan({
        runId,
        writer,
        fetchedAt: NOW,
        archiveRoot,
        fetcher: async (input) => {
          const url = String(input)
          // 400 is non-retryable so the test stays fast
          if (url.includes("coingecko")) return new Response("down", { status: 400 })
          if (url.includes("dexscreener")) {
            return new Response(JSON.stringify([]), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          }
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        },
      })
      expect(result.skipAgent).toBe(false)
      expect(result.collectionStatus).toBe("degraded")
      expect(result.marketBlind).toBe(true)
      expect(result.snapshotNames).toContain("narrative-trending")
      const trending = JSON.parse(readFileSync(
        join(agentRoot, "inbox", runId, "narrative-trending.json"),
        "utf8",
      )) as { items: { text: string }[] }
      expect(trending.items.some((item) => item.text.includes("marketBlind=true"))).toBe(true)
    } finally {
      if (prev === undefined) delete process.env["COINGECKO_DEMO_KEY"]
      else process.env["COINGECKO_DEMO_KEY"] = prev
    }
  })
})

describe("collectNarrativeScan evidence curation", () => {
  const seedSealedListRun = async (
    archiveRoot: string,
    items: readonly Record<string, unknown>[],
  ): Promise<void> => {
    const { ensureArchive, writeJsonRecordFsync, runArchiveDir } = await import(
      "../../src/lib/archive.js"
    )
    const layout = await ensureArchive(archiveRoot)
    const sealedRunId = "list-scan-2026-07-18T10-00-00-000Z"
    await writeJsonRecordFsync(join(layout.transactions, `${sealedRunId}.json`), {
      schema: 1,
      runId: sealedRunId,
      phase: "complete",
      status: "complete",
      phaseHashes: {},
      sideEffects: {},
    } as never)
    const sealedDir = runArchiveDir(layout, sealedRunId)
    mkdirSync(join(sealedDir, "inbox"), { recursive: true })
    await writeJsonRecordFsync(join(sealedDir, "manifest.json"), {
      schema: 1,
      runId: sealedRunId,
      job: "list-scan",
      createdAt: "2026-07-18T10:00:00.000Z",
      inboxSnapshotNames: ["twitter-fyp"],
    } as never)
    await writeJsonRecordFsync(join(sealedDir, "inbox", "twitter-fyp.json"), {
      source: "host.twitter.fyp",
      fetchedAt: "2026-07-18T11:30:00.000Z",
      trust: "untrusted-external",
      items,
    } as never)
  }

  const post = (author: string, text: string) => ({
    provenance: `twitter:@${author}`,
    text,
    ts: "2026-07-18T11:30:00.000Z",
    ageSec: 1800,
    freshnessTier: "live",
  })

  const emptyMarket: FetchLike = async () => new Response(
    JSON.stringify({ data: [] }),
    { status: 200, headers: { "content-type": "application/json" } },
  )

  const runScan = async (items: readonly Record<string, unknown>[]) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tc-narr-curate-")))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "inbox"), { recursive: true })
    await seedSealedListRun(archiveRoot, items)
    const runId = "narrative-scan-2026-07-18T12-00-00-000Z"
    const result = await collectNarrativeScan({
      runId,
      writer: new SnapshotWriter(agentRoot),
      fetchedAt: NOW,
      archiveRoot,
      fetcher: emptyMarket,
    })
    const readSnapshot = (name: string) => JSON.parse(readFileSync(
      join(agentRoot, "inbox", runId, `${name}.json`),
      "utf8",
    )) as { items: { text: string }[] }
    return { result, readSnapshot, archiveRoot }
  }

  it("grades clean multi-author evidence as strong", async () => {
    const { result, readSnapshot } = await runScan([
      post("alpha_caller", "base ai agents take share of daily active wallets"),
      post("second_desk", "agent frameworks on base keep shipping, fees follow"),
    ])
    expect(result.evidenceQuality?.tier).toBe("strong")
    expect(result.evidenceQuality?.independentAuthors).toBe(2)
    expect(readSnapshot("narrative-social-list").items).toHaveLength(2)
    const receipt = readSnapshot("narrative-evidence-quality").items
      .map((item) => item.text)
      .join("\n")
    expect(receipt).toContain("tier=strong")
  })

  it("filters promotion out of the derived snapshot and grades limited", async () => {
    const { result, readSnapshot, archiveRoot } = await runScan([
      post("alpha_caller", "base ai agents take share of daily active wallets"),
      post("shiller", "presale live now, don't miss the next 100x"),
      post("shiller", "last chance whitelist, join our group"),
    ])
    expect(result.evidenceQuality?.tier).toBe("limited")
    expect(result.evidenceQuality?.reasons).toContain("promotional-share-above-max")
    expect(readSnapshot("narrative-social-list").items).toHaveLength(1)

    // The raw sealed archive keeps every collected post
    const raw = JSON.parse(readFileSync(
      join(
        archiveRoot,
        "runs",
        "list-scan-2026-07-18T10-00-00-000Z",
        "inbox",
        "twitter-fyp.json",
      ),
      "utf8",
    )) as { items: unknown[] }
    expect(raw.items).toHaveLength(3)
  })
})

describe("collectNarrativeScan farcaster gate", () => {
  const seedSealedFarcasterRun = async (archiveRoot: string): Promise<void> => {
    const { ensureArchive, writeJsonRecordFsync, runArchiveDir } = await import(
      "../../src/lib/archive.js"
    )
    const layout = await ensureArchive(archiveRoot)
    const sealedRunId = "farcaster-scan-2026-07-18T10-00-00-000Z"
    await writeJsonRecordFsync(join(layout.transactions, `${sealedRunId}.json`), {
      schema: 1,
      runId: sealedRunId,
      phase: "complete",
      status: "complete",
      phaseHashes: {},
      sideEffects: {},
    } as never)
    const sealedDir = runArchiveDir(layout, sealedRunId)
    mkdirSync(join(sealedDir, "inbox"), { recursive: true })
    await writeJsonRecordFsync(join(sealedDir, "manifest.json"), {
      schema: 1,
      runId: sealedRunId,
      job: "farcaster-scan",
      createdAt: "2026-07-18T10:00:00.000Z",
      inboxSnapshotNames: ["farcaster-for-you"],
    } as never)
    await writeJsonRecordFsync(join(sealedDir, "inbox", "farcaster-for-you.json"), {
      source: "host.farcaster.for-you",
      fetchedAt: "2026-07-18T10:00:00.000Z",
      trust: "untrusted-external",
      items: [{
        provenance: `${sealedRunId}:cast:1`,
        text: "base ai agents heating",
        ts: "2026-07-18T10:00:00.000Z",
        ageSec: 0,
        freshnessTier: "live",
      }],
    } as never)
  }

  const emptyMarket: FetchLike = async () => new Response(
    JSON.stringify({ data: [] }),
    { status: 200, headers: { "content-type": "application/json" } },
  )

  it("ignores sealed farcaster runs when the lane is off", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tc-narr-fc-off-")))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "inbox"), { recursive: true })
    await seedSealedFarcasterRun(archiveRoot)

    const result = await collectNarrativeScan({
      runId: "narrative-scan-2026-07-18T12-00-00-000Z",
      writer: new SnapshotWriter(agentRoot),
      fetchedAt: NOW,
      archiveRoot,
      fetcher: emptyMarket,
    })

    expect(result.selectedRuns.farcasterScan).toBeUndefined()
    expect(result.snapshotNames).not.toContain("narrative-social-farcaster")
    const status = readFileSync(
      join(agentRoot, "inbox", "narrative-scan-2026-07-18T12-00-00-000Z", "narrative-collection-status.json"),
      "utf8",
    )
    expect(status).toContain("farcasterScan=disabled")
  })

  it("uses sealed farcaster runs on explicit opt-in", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tc-narr-fc-on-")))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "inbox"), { recursive: true })
    await seedSealedFarcasterRun(archiveRoot)

    const result = await collectNarrativeScan({
      runId: "narrative-scan-2026-07-18T12-00-00-000Z",
      writer: new SnapshotWriter(agentRoot),
      fetchedAt: NOW,
      archiveRoot,
      fetcher: emptyMarket,
      farcasterEnabled: true,
    })

    expect(result.selectedRuns.farcasterScan).toBe("farcaster-scan-2026-07-18T10-00-00-000Z")
    expect(result.snapshotNames).toContain("narrative-social-farcaster")
  })
})

describe("collectNarrativeScan status matrix", () => {
  beforeEach(() => {
    resetRateGatesForTests()
  })

  const okTrending = new Response(
    JSON.stringify({
      coins: [{ item: { id: "base-ai", name: "Base AI", symbol: "bai", market_cap_rank: 5 } }],
      categories: [{ slug: "ai-agents", name: "AI Agents", market_cap_change_24h: 12 }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )

  const runWith = async (
    fetcher: FetchLike,
    demoKey: string | undefined,
  ) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tc-narr-matrix-")))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "inbox"), { recursive: true })
    const { ensureArchive } = await import("../../src/lib/archive.js")
    await ensureArchive(archiveRoot)
    const writer = new SnapshotWriter(agentRoot)
    const runId = "narrative-scan-2026-07-18T12-00-00-000Z"
    const prev = process.env["COINGECKO_DEMO_KEY"]
    if (demoKey === undefined) delete process.env["COINGECKO_DEMO_KEY"]
    else process.env["COINGECKO_DEMO_KEY"] = demoKey
    try {
      return await collectNarrativeScan({ runId, writer, fetchedAt: NOW, archiveRoot, fetcher })
    } finally {
      if (prev === undefined) delete process.env["COINGECKO_DEMO_KEY"]
      else process.env["COINGECKO_DEMO_KEY"] = prev
    }
  }

  it("completes when CoinGecko returns coins and categories", async () => {
    const result = await runWith(async () => okTrending.clone(), "demo-key")
    expect(result.collectionStatus).toBe("completed")
    expect(result.marketBlind).toBe(false)
    expect(result.snapshotNames).toContain("narrative-trending")
  })

  it("degrades keyless (coins only, no categories)", async () => {
    const result = await runWith(async (input) => {
      if (String(input).includes("coingecko")) {
        return new Response(
          JSON.stringify({ coins: [{ item: { id: "hoodrat", name: "Hoodrat", symbol: "hood" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }, undefined)
    expect(result.collectionStatus).toBe("degraded")
    expect(result.marketBlind).toBe(true)
    expect(result.marketBlindReason).toBe("categories-unavailable")
  })

  it("skips when no market or social evidence exists", async () => {
    const result = await runWith(async (input) => {
      const url = String(input)
      if (url.includes("coingecko")) return new Response("down", { status: 400 })
      if (url.includes("dexscreener")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }, undefined)
    expect(result.collectionStatus).toBe("skipped")
    expect(result.skipAgent).toBe(true)
    expect(result.marketBlind).toBe(true)
    expect(result.snapshotNames).toContain("narrative-trending")
  })

  it("prefers an older usable sealed run over a newer empty complete run", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tc-narr-usable-")))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "inbox"), { recursive: true })
    const { ensureArchive, writeJsonRecordFsync, runArchiveDir } = await import(
      "../../src/lib/archive.js"
    )
    const layout = await ensureArchive(archiveRoot)

    const usableId = "list-scan-2026-07-18T10-00-00-000Z"
    await writeJsonRecordFsync(join(layout.transactions, `${usableId}.json`), {
      schema: 1,
      runId: usableId,
      phase: "complete",
      phaseHashes: {},
      sideEffects: {},
    } as never)
    const usableDir = runArchiveDir(layout, usableId)
    mkdirSync(join(usableDir, "inbox"), { recursive: true })
    await writeJsonRecordFsync(join(usableDir, "manifest.json"), {
      schema: 1,
      runId: usableId,
      job: "list-scan",
      createdAt: "2026-07-18T10:00:00.000Z",
      inboxSnapshotNames: ["twitter-fyp"],
    } as never)
    await writeJsonRecordFsync(join(usableDir, "inbox", "twitter-fyp.json"), {
      source: "host.twitter.fyp",
      fetchedAt: "2026-07-18T10:00:00.000Z",
      trust: "untrusted-external",
      items: [{
        provenance: `${usableId}:tweet:1`,
        text: "base ai agents heating",
        ts: "2026-07-18T10:00:00.000Z",
        ageSec: 0,
        freshnessTier: "live",
      }],
    } as never)

    const emptyId = "list-scan-2026-07-18T11-00-00-000Z"
    await writeJsonRecordFsync(join(layout.transactions, `${emptyId}.json`), {
      schema: 1,
      runId: emptyId,
      phase: "complete",
      status: "complete",
      phaseHashes: {},
      sideEffects: {},
    } as never)
    const emptyDir = runArchiveDir(layout, emptyId)
    mkdirSync(join(emptyDir, "inbox"), { recursive: true })
    await writeJsonRecordFsync(join(emptyDir, "manifest.json"), {
      schema: 1,
      runId: emptyId,
      job: "list-scan",
      createdAt: "2026-07-18T11:00:00.000Z",
      inboxSnapshotNames: [],
    } as never)

    const writer = new SnapshotWriter(agentRoot)
    const result = await collectNarrativeScan({
      runId: "narrative-scan-2026-07-18T12-00-00-000Z",
      writer,
      fetchedAt: NOW,
      archiveRoot,
      fetcher: async () => okTrending.clone(),
    })
    expect(result.selectedRuns.listScan).toBe(usableId)
    expect(result.usableEvidence).toBe(true)
  })
})

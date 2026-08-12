import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { ConfigSchema } from "../../src/lib/config.js"
import { migrateConfigToV26 } from "../../src/migrations/config.js"
import { ensureArchive, runArchiveDir } from "../../src/lib/archive.js"
import { StateStore } from "../../src/lib/state.js"
import {
  bridgeReadySocialCashtags,
  mergeSocialCashtagClusters,
  pruneSocialCashtagClusters,
  scanArchivedSocialCashtags,
} from "../../src/orchestrator/social-cashtag-bridge.js"
import type { CanonicalIdentity } from "../../src/contracts/schemas.js"

const NOW = "2026-07-20T17:00:00.000Z"
const DAY_AGO = "2026-07-19T17:00:00.000Z"
const TOKEN = "So11111111111111111111111111111111111111112"
const EVM = "0xDB87393727b666c43f5aecB03d8B419bA54D9b03"

function writeMinimalConfig(dir: string, bridge?: Record<string, unknown>): void {
  const cfg = ConfigSchema.parse(migrateConfigToV26({
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
      source_lifecycle: { promotion: {}, demotion: {} },
      engagement: {},
    },
    research: {
      daily_cap: 10,
      queue_expiry_days: 7,
      disambiguation_daily_cap: 10,
      ...(bridge ? { social_cashtag_bridge: bridge } : {}),
    },
    broadcast: {},
    indicators: {},
    gate_thresholds: {},
    audit: { rsi_promotion: {} },
    wallets: { deterministic_weight: 0.8, llm_weight: 0.2, promotion: {}, drop: {} },
    source_safety: {},
    retention: {},
    chat: {},
    router: {},
    harness_improvement: {},
  }))
  mkdirSync(join(dir, ".trenchcoat"), { recursive: true })
  writeFileSync(join(dir, ".trenchcoat", "config.json"), `${JSON.stringify(cfg, null, 2)}\n`)
}

async function scaffold(runId: string) {
  const root = mkdtempSync(join(tmpdir(), "tc-cashtag-bridge-"))
  const home = join(root, "home")
  const agentRoot = join(root, "agent")
  const archiveRoot = join(root, "archive")
  mkdirSync(join(agentRoot, "state"), { recursive: true })
  mkdirSync(join(agentRoot, "reports", runId), { recursive: true })
  writeFileSync(join(agentRoot, "state", "watchlist.json"), `${JSON.stringify({ schema: 1, entries: [] }, null, 2)}\n`)
  writeFileSync(join(agentRoot, "state", "research-queue.json"), `${JSON.stringify({ schema: 1, entries: [] }, null, 2)}\n`)
  writeFileSync(join(agentRoot, "state", "ledger.json"), `${JSON.stringify({ schema: 1, positions: [] }, null, 2)}\n`)
  writeFileSync(join(agentRoot, "state", "wallets.json"), `${JSON.stringify({ schema: 1, wallets: [] }, null, 2)}\n`)
  writeFileSync(join(agentRoot, "state", "decisions.md"), "")
  writeMinimalConfig(home)
  const prevHome = process.env["HOME"]
  process.env["HOME"] = home
  const layout = await ensureArchive(archiveRoot)
  return {
    home,
    agentRoot,
    layout,
    restore: () => {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
    },
  }
}

function writeSealedSocial(
  layout: Awaited<ReturnType<typeof ensureArchive>>,
  runId: string,
  fileName: string,
  items: readonly Readonly<{
    provenance: string
    text: string
    ts?: string
    freshnessTier?: "live" | "stale" | "expired"
    clusterId?: string
  }>[],
): void {
  const inboxDir = join(runArchiveDir(layout, runId), "inbox")
  mkdirSync(inboxDir, { recursive: true })
  writeFileSync(
    join(inboxDir, fileName),
    `${JSON.stringify({
      source: "twitter.list",
      fetchedAt: NOW,
      trust: "untrusted-external",
      items: items.map((item) => ({
        provenance: item.provenance,
        text: item.text,
        ts: item.ts ?? NOW,
        ageSec: 0,
        freshnessTier: item.freshnessTier ?? "live",
        ...(item.clusterId ? { clusterId: item.clusterId } : {}),
      })),
    }, null, 2)}\n`,
  )
}

const resolvedIdentity = (token = TOKEN): CanonicalIdentity => ({
  chain: "solana",
  tokenAddress: token,
  pairAddress: token,
  symbolDisplay: "JIMOTHY",
  resolution: "resolved",
})

describe("social-cashtag-bridge", () => {
  it("enqueues after two authors across runs", async () => {
    const runA = "list-scan-a"
    const runB = "list-scan-b"
    const s = await scaffold(runB)
    writeSealedSocial(s.layout, runA, "twitter-fyp.json", [{
      provenance: "twitter:@alice",
      text: "watching $JIMOTHY early",
      ts: DAY_AGO,
    }])
    writeSealedSocial(s.layout, runB, "twitter-fyp.json", [{
      provenance: "twitter:@bob",
      text: "$JIMOTHY looking strong",
      ts: NOW,
    }])

    const state = new StateStore(join(s.agentRoot, "state"))
    const obsA = scanArchivedSocialCashtags({
      layout: s.layout,
      runId: runA,
      skipPromotional: true,
    })
    const first = mergeSocialCashtagClusters({
      store: state.loadSocialCashtagClusters(),
      nowIso: DAY_AGO,
      windowDays: 7,
      maxClusters: 500,
      minAuthors: 2,
      observations: obsA,
    })
    await state.saveSocialCashtagClusters(first.store)

    const resolveMod = await import("../../src/orchestrator/research-collect.js")
    const spy = vi.spyOn(resolveMod, "resolveResearchSubject").mockResolvedValue({
      status: "resolved",
      identity: resolvedIdentity(),
      candidates: [],
      pairs: [],
    })
    try {
      const result = await bridgeReadySocialCashtags({
        agentRoot: s.agentRoot,
        layout: s.layout,
        runId: runB,
        nowIso: NOW,
      })
      expect(result.accepted).toHaveLength(1)
      expect(result.accepted[0]?.path).toBe("ticker-resolved")
      expect(result.accepted[0]?.authorCount).toBe(2)
      const queue = JSON.parse(
        readFileSync(join(s.agentRoot, "state", "research-queue.json"), "utf8"),
      ) as { entries: { trigger: string; clusterCount: number; priority: number }[] }
      expect(queue.entries[0]?.trigger).toBe("social")
      expect(queue.entries[0]?.clusterCount).toBe(2)
      expect(queue.entries[0]?.priority).toBe(50)
      expect(existsReceipt(s.layout, runB)).toBe(true)
    } finally {
      spy.mockRestore()
      s.restore()
    }
  })

  it("does not enqueue when the same author repeats", async () => {
    const runId = "list-scan-same-author"
    const s = await scaffold(runId)
    writeSealedSocial(s.layout, runId, "twitter-fyp.json", [
      { provenance: "twitter:@alice", text: "$JIMOTHY one" },
      { provenance: "twitter:@alice", text: "$JIMOTHY two" },
    ])
    const resolveMod = await import("../../src/orchestrator/research-collect.js")
    const spy = vi.spyOn(resolveMod, "resolveResearchSubject")
    try {
      const result = await bridgeReadySocialCashtags({
        agentRoot: s.agentRoot,
        layout: s.layout,
        runId,
        nowIso: NOW,
      })
      expect(result.accepted).toHaveLength(0)
      expect(spy).not.toHaveBeenCalled()
      const clusters = new StateStore(join(s.agentRoot, "state")).loadSocialCashtagClusters()
      expect(clusters.clusters[0]?.authors).toHaveLength(1)
      expect(clusters.clusters[0]?.status).toBe("accumulating")
    } finally {
      spy.mockRestore()
      s.restore()
    }
  })

  it("rejects generic $SOL", async () => {
    const runId = "list-scan-generic"
    const s = await scaffold(runId)
    writeSealedSocial(s.layout, runId, "twitter-fyp.json", [
      { provenance: "twitter:@alice", text: "buy $SOL now" },
      { provenance: "twitter:@bob", text: "$SOL pumping" },
    ])
    try {
      const result = await bridgeReadySocialCashtags({
        agentRoot: s.agentRoot,
        layout: s.layout,
        runId,
        nowIso: NOW,
      })
      expect(result.accepted).toHaveLength(0)
      expect(result.rejected.some((r) => r.reason === "generic-chain-symbol")).toBe(true)
    } finally {
      s.restore()
    }
  })

  it("skips promotional posts when configured", async () => {
    const runId = "list-scan-promo"
    const s = await scaffold(runId)
    writeMinimalConfig(s.home, { skip_promotional: true })
    writeSealedSocial(s.layout, runId, "twitter-fyp.json", [
      {
        provenance: "twitter:@alice",
        text: "BUY NOW $JIMOTHY $FOO $BAR $BAZ guaranteed 100x #moon #gem #alpha #pump",
      },
      { provenance: "twitter:@bob", text: "$JIMOTHY looking clean" },
    ])
    try {
      const obs = scanArchivedSocialCashtags({
        layout: s.layout,
        runId,
        skipPromotional: true,
      })
      expect(obs.every((o) => o.authorKey.includes("bob"))).toBe(true)
      const result = await bridgeReadySocialCashtags({
        agentRoot: s.agentRoot,
        layout: s.layout,
        runId,
        nowIso: NOW,
      })
      expect(result.accepted).toHaveLength(0)
    } finally {
      s.restore()
    }
  })

  it("enqueues on deterministic resolve", async () => {
    const runId = "list-scan-resolved"
    const s = await scaffold(runId)
    writeSealedSocial(s.layout, runId, "twitter-fyp.json", [
      { provenance: "twitter:@alice", text: "$JIMOTHY early" },
      { provenance: "twitter:@bob", text: "$JIMOTHY looking strong" },
    ])
    const resolveMod = await import("../../src/orchestrator/research-collect.js")
    const spy = vi.spyOn(resolveMod, "resolveResearchSubject").mockResolvedValue({
      status: "resolved",
      identity: resolvedIdentity(),
      candidates: [],
      pairs: [],
    })
    try {
      const result = await bridgeReadySocialCashtags({
        agentRoot: s.agentRoot,
        layout: s.layout,
        runId,
        nowIso: NOW,
      })
      expect(result.accepted).toHaveLength(1)
      expect(result.accepted[0]?.path).toBe("ticker-resolved")
      expect(result.accepted[0]?.tokenAddress).toBe(TOKEN)
    } finally {
      spy.mockRestore()
      s.restore()
    }
  })

  it("model-confirms an ambiguous shortlist", async () => {
    const runId = "list-scan-ambig"
    const s = await scaffold(runId)
    writeSealedSocial(s.layout, runId, "twitter-fyp.json", [
      { provenance: "twitter:@alice", text: "$SWOGE on robinhood chain" },
      { provenance: "twitter:@bob", text: "$SWOGE rh eco" },
    ])
    const idA: CanonicalIdentity = {
      chain: "robinhood",
      tokenAddress: EVM,
      pairAddress: EVM,
      symbolDisplay: "SWOGE",
      resolution: "ambiguous",
    }
    const idB: CanonicalIdentity = {
      chain: "robinhood",
      tokenAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      pairAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      symbolDisplay: "SWOGE",
      resolution: "ambiguous",
    }
    const resolveMod = await import("../../src/orchestrator/research-collect.js")
    const securityMod = await import("../../src/collectors/market/security.js")
    const spy = vi.spyOn(resolveMod, "resolveResearchSubject").mockResolvedValue({
      status: "ambiguous",
      shortlist: [idA, idB],
    })
    const secSpy = vi.spyOn(securityMod, "fetchSecurityGate").mockResolvedValue({
      status: "pass",
      hardFail: false,
      flags: [],
    })
    try {
      const result = await bridgeReadySocialCashtags({
        agentRoot: s.agentRoot,
        layout: s.layout,
        runId,
        nowIso: NOW,
        runDisambiguation: async () => JSON.stringify({
          pick: `robinhood:${EVM}`,
          confidence: 85,
        }),
      })
      expect(result.accepted).toHaveLength(1)
      expect(result.accepted[0]?.path).toBe("ticker-model")
      const clusters = new StateStore(join(s.agentRoot, "state")).loadSocialCashtagClusters()
      expect(clusters.disambiguationsToday?.count).toBe(1)
    } finally {
      spy.mockRestore()
      secSpy.mockRestore()
      s.restore()
    }
  })

  it("parks on low confidence", async () => {
    const runId = "list-scan-low-conf"
    const s = await scaffold(runId)
    writeSealedSocial(s.layout, runId, "twitter-fyp.json", [
      { provenance: "twitter:@alice", text: "$SWOGE on robinhood chain" },
      { provenance: "twitter:@bob", text: "$SWOGE rh eco" },
    ])
    const idA: CanonicalIdentity = {
      chain: "robinhood",
      tokenAddress: EVM,
      pairAddress: EVM,
      symbolDisplay: "SWOGE",
      resolution: "ambiguous",
    }
    const idB: CanonicalIdentity = {
      chain: "robinhood",
      tokenAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      pairAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      symbolDisplay: "SWOGE",
      resolution: "ambiguous",
    }
    const resolveMod = await import("../../src/orchestrator/research-collect.js")
    const securityMod = await import("../../src/collectors/market/security.js")
    const spy = vi.spyOn(resolveMod, "resolveResearchSubject").mockResolvedValue({
      status: "ambiguous",
      shortlist: [idA, idB],
    })
    const secSpy = vi.spyOn(securityMod, "fetchSecurityGate").mockResolvedValue({
      status: "pass",
      hardFail: false,
      flags: [],
    })
    try {
      const result = await bridgeReadySocialCashtags({
        agentRoot: s.agentRoot,
        layout: s.layout,
        runId,
        nowIso: NOW,
        runDisambiguation: async () => JSON.stringify({ pick: null, confidence: 10 }),
      })
      expect(result.accepted).toHaveLength(0)
      expect(result.parked).toHaveLength(1)
      expect(result.parked[0]?.subject).toBe("SWOGE")
    } finally {
      spy.mockRestore()
      secSpy.mockRestore()
      s.restore()
    }
  })

  it("skips watchlist and queue duplicates", async () => {
    const runId = "list-scan-dupe"
    const s = await scaffold(runId)
    writeSealedSocial(s.layout, runId, "twitter-fyp.json", [
      { provenance: "twitter:@alice", text: "$JIMOTHY" },
      { provenance: "twitter:@bob", text: "$JIMOTHY" },
    ])
    writeFileSync(
      join(s.agentRoot, "state", "watchlist.json"),
      `${JSON.stringify({
        schema: 1,
        entries: [{
          schema: 1,
          identity: resolvedIdentity(),
          status: "tracking",
          addedAt: NOW,
          updatedAt: NOW,
        }],
      }, null, 2)}\n`,
    )
    const resolveMod = await import("../../src/orchestrator/research-collect.js")
    const spy = vi.spyOn(resolveMod, "resolveResearchSubject").mockResolvedValue({
      status: "resolved",
      identity: resolvedIdentity(),
      candidates: [],
      pairs: [],
    })
    try {
      const result = await bridgeReadySocialCashtags({
        agentRoot: s.agentRoot,
        layout: s.layout,
        runId,
        nowIso: NOW,
      })
      expect(result.accepted).toHaveLength(0)
      expect(result.rejected.some((r) => r.reason === "duplicated-watchlist")).toBe(true)
    } finally {
      spy.mockRestore()
      s.restore()
    }
  })

  it("caps enqueues at 3 per run", async () => {
    const runId = "list-scan-cap"
    const s = await scaffold(runId)
    const tickers = ["AAA", "BBB", "CCC", "DDD"]
    writeSealedSocial(
      s.layout,
      runId,
      "twitter-fyp.json",
      tickers.flatMap((t) => [
        { provenance: "twitter:@alice", text: `$${t}` },
        { provenance: "twitter:@bob", text: `$${t}` },
      ]),
    )
    let n = 0
    const resolveMod = await import("../../src/orchestrator/research-collect.js")
    const spy = vi.spyOn(resolveMod, "resolveResearchSubject").mockImplementation(async (input) => {
      n += 1
      const token = `${TOKEN.slice(0, -1)}${n}`
      return {
        status: "resolved" as const,
        identity: {
          chain: "solana" as const,
          tokenAddress: token,
          pairAddress: token,
          symbolDisplay: String(input.subject),
          resolution: "resolved" as const,
        },
        candidates: [],
        pairs: [],
      }
    })
    try {
      const result = await bridgeReadySocialCashtags({
        agentRoot: s.agentRoot,
        layout: s.layout,
        runId,
        nowIso: NOW,
      })
      expect(result.accepted).toHaveLength(3)
      expect(result.rejected.some((r) => r.reason === "over-cap")).toBe(true)
    } finally {
      spy.mockRestore()
      s.restore()
    }
  })

  it("prunes clusters outside the window", () => {
    const old = "2026-06-01T00:00:00.000Z"
    const pruned = pruneSocialCashtagClusters({
      schema: 1,
      clusters: [{
        clusterKey: "OLD",
        symbol: "OLD",
        authors: ["twitter:@alice"],
        evidenceRefs: ["inbox/r/twitter-fyp.json"],
        firstSeen: old,
        lastSeen: old,
        status: "accumulating",
      }],
    }, NOW, 7)
    expect(pruned.clusters).toHaveLength(0)
  })

  it("skips expired inbox items", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-cashtag-expired-"))
    const layoutPromise = ensureArchive(join(root, "archive"))
    return layoutPromise.then((layout) => {
      const runId = "list-scan-expired"
      writeSealedSocial(layout, runId, "twitter-fyp.json", [
        {
          provenance: "twitter:@alice",
          text: "$JIMOTHY",
          freshnessTier: "expired",
        },
        {
          provenance: "twitter:@bob",
          text: "$JIMOTHY",
          freshnessTier: "live",
        },
      ])
      const obs = scanArchivedSocialCashtags({
        layout,
        runId,
        skipPromotional: true,
      })
      expect(obs).toHaveLength(1)
      expect(obs[0]?.authorKey).toBe("twitter:@bob")
    })
  })

  it("rejects queue duplicates", async () => {
    const runId = "list-scan-queue-dupe"
    const s = await scaffold(runId)
    writeSealedSocial(s.layout, runId, "twitter-fyp.json", [
      { provenance: "twitter:@alice", text: "$JIMOTHY" },
      { provenance: "twitter:@bob", text: "$JIMOTHY" },
    ])
    writeFileSync(
      join(s.agentRoot, "state", "research-queue.json"),
      `${JSON.stringify({
        schema: 1,
        entries: [{
          schema: 1,
          queueId: "rq-existing",
          subject: `solana:${TOKEN}`,
          chain: "solana",
          tokenAddress: TOKEN,
          resolution: "resolved",
          priority: 50,
          firstSeen: NOW,
          enqueuedAt: NOW,
          enqueuedBy: "test",
          trigger: "social",
          expiresAt: "2026-08-01T00:00:00.000Z",
          provenance: ["test"],
          clusterCount: 2,
          security: { status: "pending", flags: [] },
          status: "pending",
          reason: "prior",
        }],
      }, null, 2)}\n`,
    )
    const resolveMod = await import("../../src/orchestrator/research-collect.js")
    const spy = vi.spyOn(resolveMod, "resolveResearchSubject").mockResolvedValue({
      status: "resolved",
      identity: resolvedIdentity(),
      candidates: [],
      pairs: [],
    })
    try {
      const result = await bridgeReadySocialCashtags({
        agentRoot: s.agentRoot,
        layout: s.layout,
        runId,
        nowIso: NOW,
      })
      expect(result.accepted).toHaveLength(0)
      expect(result.rejected.some((r) => r.reason === "duplicated-queue")).toBe(true)
    } finally {
      spy.mockRestore()
      s.restore()
    }
  })
})

function existsReceipt(
  layout: Awaited<ReturnType<typeof ensureArchive>>,
  runId: string,
): boolean {
  try {
    readFileSync(
      join(runArchiveDir(layout, runId), "social-cashtag-bridge-receipt.json"),
      "utf8",
    )
    return true
  } catch {
    return false
  }
}

import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive } from "../../src/lib/archive.js"
import {
  buildMarketQualityEvidence,
  formatMarketQualitySnapshotText,
  parseMarketQualityText,
  resolveMarketQualityFromArchive,
  writeMarketQualityReceipt,
} from "../../src/orchestrator/market-quality-evidence.js"
import type { DecisionProposal, MarketQualityReceipt } from "../../src/contracts/schemas.js"
import type { MarketPair } from "../../src/collectors/market/providers.js"

const identity = {
  chain: "solana" as const,
  tokenAddress: "So11111111111111111111111111111111111111112",
  pairAddress: "pair1111111111111111111111111111111111111111",
  symbolDisplay: "SOL",
  resolution: "resolved" as const,
}

function baseProposal(runId: string): DecisionProposal {
  return {
    schema: 1,
    proposalId: "p1",
    runId,
    proposedAt: "2026-07-17T12:00:00.000Z",
    provenanceIds: ["x:list:a"],
    card: {
      decisionId: "d1",
      runId,
      decisionTs: "2026-07-17T12:00:00.000Z",
      verdict: "track",
      identity,
      thesis: "t",
      horizonHours: 72,
      invalidation: "x",
      drivers: ["social"],
      confidence: 60,
      signalUse: {},
      sources: ["x:list:a"],
      clusters: 1,
      countercase: "c",
      gate: "pass",
    },
    externalEffects: [],
  }
}

function pair(overrides: Partial<MarketPair> = {}): MarketPair {
  return {
    chainId: "solana",
    pairAddress: identity.pairAddress,
    url: "https://example.com",
    baseToken: { address: identity.tokenAddress, symbol: "SOL", name: "Sol" },
    quoteToken: { address: "quote", symbol: "USDC", name: "USDC" },
    buys24h: 100,
    sells24h: 100,
    liquidityUsd: 100_000,
    fdv: 1_000_000,
    ...overrides,
  }
}

describe("market quality evidence", () => {
  it("builds, formats, and parses a pass snapshot", () => {
    const evidence = buildMarketQualityEvidence({
      identity,
      pair: pair(),
      previousLiquidityUsd: 100_000,
      evaluatedAt: "2026-07-17T12:00:00.000Z",
      source: "live-collect",
    })
    expect(evidence.status).toBe("pass")
    const text = formatMarketQualitySnapshotText(evidence)
    expect(text).toContain("status=pass")
    expect(text).toContain("reasons=none")
    expect(text).toContain("previousLiquidityUsd=100000")
    const parsed = parseMarketQualityText(text)
    expect(parsed).toMatchObject({ status: "pass", reasons: [] })
  })

  it("parses fail reasons from snapshot text", () => {
    const text = [
      "chain=solana",
      `token=${identity.tokenAddress}`,
      `pair=${identity.pairAddress}`,
      "status=fail",
      "reasons=liquidity,transactions",
      "liquidityUsd=10",
      "previousLiquidityUsd=n/a",
    ].join(" ")
    expect(parseMarketQualityText(text)).toMatchObject({
      status: "fail",
      reasons: ["liquidity", "transactions"],
    })
  })

  it("resolves archived market-quality dossier and writes receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-mq-"))
    try {
      const layout = await ensureArchive(join(root, "archive"))
      const runId = "run-1"
      const inbox = join(layout.runs, runId, "inbox")
      mkdirSync(inbox, { recursive: true })
      writeFileSync(join(inbox, "market-quality.json"), `${JSON.stringify({
        source: "host.market-quality",
        fetchedAt: "2026-07-17T12:00:00.000Z",
        trust: "untrusted-external",
        items: [{
          provenance: "run-1:market-quality:solana:So11111111111111111111111111111111111111112",
          dedupeKey: "solana:So11111111111111111111111111111111111111112",
          text: [
            "chain=solana",
            `token=${identity.tokenAddress}`,
            `pair=${identity.pairAddress}`,
            "status=fail",
            "reasons=liquidity",
            "liquidityUsd=10",
            "previousLiquidityUsd=n/a",
          ].join(" "),
          ts: "2026-07-17T12:00:00.000Z",
          ageSec: 0,
          freshnessTier: "live",
        }],
      })}\n`)

      const resolved = resolveMarketQualityFromArchive(
        layout,
        runId,
        baseProposal(runId),
        "2026-07-17T12:01:00.000Z",
      )
      expect(resolved?.status).toBe("fail")
      expect(resolved?.reasons).toEqual(["liquidity"])
      expect(resolved?.receipt.source).toBe("archived-dossier")

      await writeMarketQualityReceipt(layout, runId, resolved!.receipt)
      const written = JSON.parse(readFileSync(
        join(
          layout.runs,
          runId,
          "market-quality-receipts",
          `${resolved!.receipt.receiptId.slice(7, 23)}.json`,
        ),
        "utf8",
      )) as MarketQualityReceipt
      expect(written.status).toBe("fail")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("returns undefined when archive dossier is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-mq-miss-"))
    try {
      const layout = await ensureArchive(join(root, "archive"))
      const runId = "run-2"
      mkdirSync(join(layout.runs, runId, "inbox"), { recursive: true })
      expect(resolveMarketQualityFromArchive(
        layout,
        runId,
        baseProposal(runId),
        "2026-07-17T12:01:00.000Z",
      )).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

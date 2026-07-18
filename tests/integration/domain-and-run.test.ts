import { describe, expect, it } from "vitest"
import { mkdtempSync, cpSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runJob } from "../../src/orchestrator/run.js"
import {
  blendWalletScores,
  deterministicWalletScore,
  parseWalletVote,
  shouldPromote,
} from "../../src/wallets/scoring.js"
import { extractCallEvents } from "../../src/lib/call-events.js"
import { parseIntentVerdict } from "../../src/lib/source-scoring.js"
import { canSendBroadcast, dayKey } from "../../src/orchestrator/broadcast.js"
import { renderChartSvg, chartManifest } from "../../src/charts/render.js"
import type { OhlcvCandle } from "../../src/collectors/market/geckoterminal.js"
import { resolveFromCandidates } from "../../src/lib/resolve.js"
import { firstEligibleObservation, openEntryPending, finalizeEntry } from "../../src/orchestrator/ledger.js"
import { wilsonLowerBound } from "../../src/orchestrator/audit-math.js"
import { isChatAllowed, handleChatUpdate } from "../../src/chat/handler.js"

describe("integration run loop", () => {
  it("completes a dry skip-agent job under lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-run-"))
    const agentRoot = join(root, "agent")
    cpSync(join(process.cwd(), "agent"), agentRoot, { recursive: true })
    mkdirSync(join(root, "archive"), { recursive: true })
    const result = await runJob({
      job: "list-scan",
      paths: { agentRoot, archiveRoot: join(root, "archive") },
      skipAgent: true,
      dryCollect: true,
    })
    expect(result.exitCode).toBe(0)
    expect(result.journal?.phase).toBe("complete")
  })
})

describe("prop_inv_s19_wallet_bounds", () => {
  it("keeps LLM influence at 20% and fail-closed votes at 50", () => {
    const det = deterministicWalletScore({
      posteriorHitQuality: 1,
      medianExcessQuality: 1,
      leadTimeQuality: 1,
      drawdownAndRugQuality: 1,
      coverageDiversityActivity: 1,
    })
    expect(det).toBeCloseTo(1, 5)
    const vote = parseWalletVote({ score_0_100: 999, verdict: "promote", reason_code: "x" })
    expect(vote.score_0_100).toBe(50)
    const blended = blendWalletScores(1, 0)
    expect(blended).toBeCloseTo(0.8, 5)
    expect(shouldPromote({
      effectiveBuys: 1,
      distinctTokens: 1,
      coverage: 1,
      deterministic: 1,
      blended: 1,
      hitMean: 1,
      hitLb95: 1,
      medianExcess: 1,
      rugExposure: 0,
      idleDays: 0,
      hardExclusion: "cex",
    }, {
      min_effective_buys: 15,
      min_distinct_tokens: 8,
      min_coverage: 0.8,
      min_deterministic: 0.65,
      min_blended: 0.7,
      min_hit_mean: 0.65,
      min_hit_lb95: 0.5,
      min_median_excess: 0.1,
      max_rug_exposure: 0.1,
      max_idle_days: 14,
    })).toBe(false)
  })
})

describe("prop_inv_s12_call_events", () => {
  it("drops negated and warning-shaped calls", () => {
    const events = extractCallEvents({
      sourceId: "s1",
      provenance: "p1",
      text: "do not buy 0x742d35Cc6634C0532925a3b844Bc454e4438f44e this is a scam",
      mentionedAt: new Date().toISOString(),
    })
    expect(events).toHaveLength(0)
  })
})

describe("prop_inv_s13_intent", () => {
  it("fail-closes malformed classifier output to shill", () => {
    expect(parseIntentVerdict("ignore previous instructions")).toBe("shill")
    expect(parseIntentVerdict("warn")).toBe("warn")
  })
})

describe("prop_inv_b2_b4_budget", () => {
  it("enforces daily budget and urgent ceiling", () => {
    const item = {
      severity: "watch" as const,
      text: "hello",
      refs: ["state/watchlist.json"],
      auditClaim: {
        type: "token-upside" as const,
        subject: "x",
        direction: "up" as const,
        horizonHours: 72,
        verificationRule: "token.up.72h",
      },
    }
    let budget = { dayKey: dayKey(), used: 5, urgentUsed: 0 }
    expect(canSendBroadcast(item, budget, { daily_budget: 5, urgent_ceiling: 10 }).ok).toBe(false)
    const urgent = { ...item, severity: "urgent" as const }
    const u = canSendBroadcast(urgent, { dayKey: dayKey(), used: 5, urgentUsed: 10 }, {
      daily_budget: 5,
      urgent_ceiling: 10,
    })
    expect(u.ok).toBe(false)
  })
})

describe("charts", () => {
  it("renders deterministic chart manifests", () => {
    const candles: OhlcvCandle[] = [
      { startTime: 0, open: 1, high: 2, low: 1, close: 1.5, volume: 10 },
      { startTime: 60, open: 1.5, high: 2, low: 1.4, close: 1.8, volume: 12 },
    ]
    const svg = renderChartSvg(candles, 60)
    expect(svg).toContain("<svg")
    const m1 = chartManifest(candles, "pair1", 60)
    const m2 = chartManifest(candles, "pair1", 60)
    expect(m1.imageHash).toBe(m2.imageHash)
    expect(m1.candleHash).toBe(m2.candleHash)
  })
})

describe("resolution and ledger", () => {
  it("resolves dominant pair and books first post-decision observation", () => {
    const resolved = resolveFromCandidates([{
      chain: "ethereum",
      tokenAddress: "0x742d35cc6634c0532925a3b844bc454e4438f44e",
      pairAddress: "0x742d35cc6634c0532925a3b844bc454e4438f44e",
      symbolDisplay: "TEST",
      liquidityUsd: 100_000,
      volume24hUsd: 50_000,
    }])
    expect(resolved.status).toBe("resolved")
    if (resolved.status !== "resolved") return
    const position = openEntryPending({
      positionId: "pos1",
      decisionId: "dec1",
      identity: resolved.identity,
      openedAt: "2026-01-01T00:00:00.000Z",
    })
    const obs = firstEligibleObservation("2026-01-01T00:00:00.000Z", [
      { ts: "2026-01-01T00:00:00.000Z", open: 1, hash: `sha256:${"a".repeat(64)}` },
      { ts: "2026-01-01T00:05:00.000Z", open: 1.1, hash: `sha256:${"b".repeat(64)}` },
    ])
    expect(obs?.open).toBe(1.1)
    const open = finalizeEntry(position, obs!)
    expect(open.status).toBe("open")
    expect(open.entryPrice).toBe(1.1)
  })
})

describe("audit math", () => {
  it("computes wilson lower bound", () => {
    expect(wilsonLowerBound(65, 100)).toBeGreaterThan(0.5)
  })
})

describe("chat allowlist", () => {
  it("ignores non-allowlisted users before reply", async () => {
    const result = await handleChatUpdate({
      chatId: "1",
      userId: "evil",
      text: "/status",
      allowlist: ["ops"],
      runTurn: async () => {
        throw new Error("should not run")
      },
      send: async () => {
        throw new Error("should not send")
      },
    })
    expect(result).toBe("ignored")
    expect(isChatAllowed("ops", ["ops"])).toBe(true)
  })
})

import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../../src/lib/state.js"
import { applyDecisionProposals } from "../../src/orchestrator/proposals.js"
import type { DecisionProposalFile, MarketQualityReceipt } from "../../src/contracts/schemas.js"

function fixtureRoot(): { agentRoot: string, runId: string } {
  const root = mkdtempSync(join(tmpdir(), "tc-prop-"))
  const agentRoot = join(root, "agent")
  mkdirSync(join(agentRoot, "state"), { recursive: true })
  mkdirSync(join(agentRoot, "reports", "run-1"), { recursive: true })
  return { agentRoot, runId: "run-1" }
}

const identity = {
  chain: "solana" as const,
  tokenAddress: "So11111111111111111111111111111111111111112",
  pairAddress: "pair1111111111111111111111111111111111111111",
  symbolDisplay: "SOL",
  resolution: "resolved" as const,
}

function mqResolve(
  receiptId: `sha256:${string}`,
  status: "pass" | "fail" = "pass",
  reasons: MarketQualityReceipt["reasons"] = [],
) {
  return async () => ({
    receiptId,
    status,
    reasons,
    receipt: {
      schema: 1 as const,
      receiptId,
      decisionId: "d1",
      chain: identity.chain,
      tokenAddress: identity.tokenAddress,
      pairAddress: identity.pairAddress,
      status,
      reasons,
      source: "archived-dossier" as const,
      evaluatedAt: "2026-07-16T12:01:00.000Z",
    },
  })
}

describe("host decision proposals", () => {
  it("treats malformed decision-proposals as empty (fail closed)", async () => {
    const { agentRoot, runId } = fixtureRoot()
    writeFileSync(
      join(agentRoot, "reports", runId, "decision-proposals.json"),
      `${JSON.stringify({
        schema: 1,
        runId,
        proposals: [{
          action: "revisit",
          subject: "solana:So11111111111111111111111111111111111111112",
          rationale: "invented envelope",
        }],
      }, null, 2)}\n`,
    )
    const state = new StateStore(join(agentRoot, "state"))
    const result = await applyDecisionProposals({
      agentRoot,
      runId,
      state,
      nowIso: "2026-07-16T12:01:00.000Z",
      policyVersion: "baseline",
      assignment: "baseline",
      blockExternalEffects: false,
    })
    expect(result.accepted).toBe(0)
    expect(result.rejected).toBe(0)
    expect(state.loadWatchlist().entries).toHaveLength(0)
  })

  it("applies track proposals to watchlist and ledger", async () => {
    const { agentRoot, runId } = fixtureRoot()
    const file: DecisionProposalFile = {
      schema: 1,
      runId,
      proposedAt: "2026-07-16T12:00:00.000Z",
      proposals: [{
        schema: 1,
        proposalId: "p1",
        runId,
        proposedAt: "2026-07-16T12:00:00.000Z",
        card: {
          decisionId: "d1",
          runId,
          decisionTs: "2026-07-16T12:00:00.000Z",
          verdict: "track",
          identity,
          thesis: "early attention",
          horizonHours: 72,
          invalidation: "liquidity collapse",
          drivers: ["social"],
          confidence: 60,
          signalUse: { rsi: "observed" },
          sources: ["twitter:@a"],
          clusters: 1,
          countercase: "could be exit liquidity",
          gate: "pass",
        },
        provenanceIds: ["twitter:@a"],
        externalEffects: ["broadcast"],
      }],
    }
    writeFileSync(
      join(agentRoot, "reports", runId, "decision-proposals.json"),
      `${JSON.stringify(file, null, 2)}\n`,
    )
    const state = new StateStore(join(agentRoot, "state"))
    const result = await applyDecisionProposals({
      agentRoot,
      runId,
      state,
      nowIso: "2026-07-16T12:01:00.000Z",
      policyVersion: "baseline",
      assignment: "baseline",
      blockExternalEffects: false,
      resolveGate: async () => ({
        receiptId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "pass",
      }),
      resolveMarketQuality: mqResolve(
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      ),
    })
    expect(result.accepted).toBe(1)
    expect(result.committed).toBe(true)
    expect(state.loadWatchlist().entries[0]?.status).toBe("tracking")
    expect(state.loadLedger().positions[0]?.status).toBe("entry-pending")
    expect(state.readDecisions()).toContain("d1")
  })

  it("plans track without committing when commit:false", async () => {
    const { agentRoot, runId } = fixtureRoot()
    const file: DecisionProposalFile = {
      schema: 1,
      runId,
      proposedAt: "2026-07-16T12:00:00.000Z",
      proposals: [{
        schema: 1,
        proposalId: "p1b",
        runId,
        proposedAt: "2026-07-16T12:00:00.000Z",
        card: {
          decisionId: "d1b",
          runId,
          decisionTs: "2026-07-16T12:00:00.000Z",
          verdict: "track",
          identity,
          thesis: "early attention",
          horizonHours: 72,
          invalidation: "liquidity collapse",
          drivers: ["social"],
          confidence: 60,
          signalUse: { rsi: "observed" },
          sources: ["twitter:@a"],
          clusters: 1,
          countercase: "could be exit liquidity",
          gate: "pass",
        },
        provenanceIds: ["twitter:@a"],
        externalEffects: [],
      }],
    }
    writeFileSync(
      join(agentRoot, "reports", runId, "decision-proposals.json"),
      `${JSON.stringify(file, null, 2)}\n`,
    )
    const state = new StateStore(join(agentRoot, "state"))
    const planned = await applyDecisionProposals({
      agentRoot,
      runId,
      state,
      nowIso: "2026-07-16T12:01:00.000Z",
      policyVersion: "baseline",
      assignment: "baseline",
      blockExternalEffects: false,
      commit: false,
      resolveGate: async () => ({
        receiptId: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        status: "pass",
      }),
      resolveMarketQuality: mqResolve(
        "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      ),
    })
    expect(planned.accepted).toBe(1)
    expect(planned.committed).toBe(false)
    expect(planned.plannedWatchlist.entries[0]?.status).toBe("tracking")
    expect(state.loadWatchlist().entries).toHaveLength(0)
    expect(state.readDecisions()).toBe("")
  })

  it("rejects track when gate resolver is omitted", async () => {
    const { agentRoot, runId } = fixtureRoot()
    const file: DecisionProposalFile = {
      schema: 1,
      runId,
      proposedAt: "2026-07-16T12:00:00.000Z",
      proposals: [{
        schema: 1,
        proposalId: "p1c",
        runId,
        proposedAt: "2026-07-16T12:00:00.000Z",
        card: {
          decisionId: "d1c",
          runId,
          decisionTs: "2026-07-16T12:00:00.000Z",
          verdict: "track",
          identity,
          thesis: "early attention",
          horizonHours: 72,
          invalidation: "x",
          drivers: ["social"],
          confidence: 60,
          signalUse: {},
          sources: ["twitter:@a"],
          clusters: 1,
          countercase: "n/a",
          gate: "pass",
        },
        provenanceIds: ["twitter:@a"],
        externalEffects: [],
      }],
    }
    writeFileSync(
      join(agentRoot, "reports", runId, "decision-proposals.json"),
      `${JSON.stringify(file, null, 2)}\n`,
    )
    const state = new StateStore(join(agentRoot, "state"))
    const result = await applyDecisionProposals({
      agentRoot,
      runId,
      state,
      nowIso: "2026-07-16T12:01:00.000Z",
      policyVersion: "baseline",
      assignment: "baseline",
      blockExternalEffects: false,
    })
    expect(result.accepted).toBe(0)
    expect(result.rejected).toBe(1)
    expect(result.receipts[0]?.rejectReason).toBe("gate resolver required")
  })

  it("blocks candidate external effects and rejects unbound track", async () => {
    const { agentRoot, runId } = fixtureRoot()
    const file: DecisionProposalFile = {
      schema: 1,
      runId,
      proposedAt: "2026-07-16T12:00:00.000Z",
      proposals: [{
        schema: 1,
        proposalId: "p2",
        runId,
        proposedAt: "2026-07-16T12:00:00.000Z",
        card: {
          decisionId: "d2",
          runId,
          decisionTs: "2026-07-16T12:00:00.000Z",
          verdict: "track",
          thesis: "no identity",
          horizonHours: 24,
          invalidation: "x",
          drivers: ["social"],
          confidence: 50,
          signalUse: {},
          sources: [],
          clusters: 0,
          countercase: "none",
          gate: "fail",
        },
        provenanceIds: [],
        externalEffects: ["broadcast", "router"],
      }],
    }
    writeFileSync(
      join(agentRoot, "reports", runId, "decision-proposals.json"),
      `${JSON.stringify(file, null, 2)}\n`,
    )
    const state = new StateStore(join(agentRoot, "state"))
    const result = await applyDecisionProposals({
      agentRoot,
      runId,
      state,
      nowIso: "2026-07-16T12:01:00.000Z",
      policyVersion: "candidate:hyp-1",
      assignment: "candidate",
      blockExternalEffects: true,
    })
    expect(result.accepted).toBe(0)
    expect(result.rejected).toBe(1)
    expect(result.receipts[0]?.blockedExternalEffects).toEqual(["broadcast", "router"])
  })

  it("rejects mintable memecoin track and accepts justified utility mint", async () => {
    const { agentRoot, runId } = fixtureRoot()
    const meme: DecisionProposalFile = {
      schema: 1,
      runId,
      proposedAt: "2026-07-16T12:00:00.000Z",
      proposals: [{
        schema: 1,
        proposalId: "p-meme",
        runId,
        proposedAt: "2026-07-16T12:00:00.000Z",
        card: {
          decisionId: "d-meme",
          runId,
          decisionTs: "2026-07-16T12:00:00.000Z",
          verdict: "track",
          identity,
          thesis: "meme pump",
          horizonHours: 24,
          invalidation: "fade",
          drivers: ["social"],
          confidence: 40,
          signalUse: {},
          sources: ["twitter:@a"],
          clusters: 1,
          countercase: "rug",
          gate: "pass with mint caution",
          projectClassification: "memecoin",
          mintAssessment: {
            active: true,
            justified: false,
            rationale: "infinite mint on a meme",
          },
        },
        provenanceIds: ["twitter:@a"],
        externalEffects: [],
      }],
    }
    writeFileSync(
      join(agentRoot, "reports", runId, "decision-proposals.json"),
      `${JSON.stringify(meme, null, 2)}\n`,
    )
    const state = new StateStore(join(agentRoot, "state"))
    const blocked = await applyDecisionProposals({
      agentRoot,
      runId,
      state,
      nowIso: "2026-07-16T12:01:00.000Z",
      policyVersion: "baseline",
      assignment: "baseline",
      blockExternalEffects: false,
      resolveGate: async () => ({
        receiptId: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        status: "pass",
        flags: ["mint-authority"],
      }),
      resolveMarketQuality: mqResolve(
        "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      ),
    })
    expect(blocked.accepted).toBe(0)
    expect(blocked.rejected).toBe(1)
    expect(blocked.receipts[0]?.rejectReason).toBe("mintable-memecoin")
    expect(state.loadWatchlist().entries).toHaveLength(0)

    const utility: DecisionProposalFile = {
      schema: 1,
      runId,
      proposedAt: "2026-07-16T12:00:00.000Z",
      proposals: [{
        schema: 1,
        proposalId: "p-util",
        runId,
        proposedAt: "2026-07-16T12:00:00.000Z",
        card: {
          decisionId: "d-util",
          runId,
          decisionTs: "2026-07-16T12:00:00.000Z",
          verdict: "track",
          identity,
          thesis: "capped PoW emissions",
          horizonHours: 168,
          invalidation: "mint acceleration",
          drivers: ["product"],
          confidence: 70,
          signalUse: {},
          sources: ["web:docs"],
          clusters: 1,
          countercase: "emission schedule slips",
          gate: "pass with mint caution",
          projectClassification: "utility",
          mintAssessment: {
            active: true,
            justified: true,
            rationale: "capped 131M emission over 15.5y via PoW rewards",
          },
        },
        provenanceIds: ["web:docs"],
        externalEffects: [],
      }],
    }
    writeFileSync(
      join(agentRoot, "reports", runId, "decision-proposals.json"),
      `${JSON.stringify(utility, null, 2)}\n`,
    )
    const allowed = await applyDecisionProposals({
      agentRoot,
      runId,
      state,
      nowIso: "2026-07-16T12:02:00.000Z",
      policyVersion: "baseline",
      assignment: "baseline",
      blockExternalEffects: false,
      resolveGate: async () => ({
        receiptId: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        status: "pass",
        flags: ["mintable"],
      }),
      resolveMarketQuality: mqResolve(
        "sha256:4444444444444444444444444444444444444444444444444444444444444444",
      ),
    })
    expect(allowed.accepted).toBe(1)
    expect(allowed.receipts[0]?.accepted).toBe(true)
    expect(state.loadWatchlist().entries[0]?.status).toBe("tracking")
  })

  it("rejects mintable track when projectClassification is missing", async () => {
    const { agentRoot, runId } = fixtureRoot()
    const file: DecisionProposalFile = {
      schema: 1,
      runId,
      proposedAt: "2026-07-16T12:00:00.000Z",
      proposals: [{
        schema: 1,
        proposalId: "p-missing",
        runId,
        proposedAt: "2026-07-16T12:00:00.000Z",
        card: {
          decisionId: "d-missing",
          runId,
          decisionTs: "2026-07-16T12:00:00.000Z",
          verdict: "track",
          identity,
          thesis: "unclear",
          horizonHours: 72,
          invalidation: "x",
          drivers: ["social"],
          confidence: 50,
          signalUse: {},
          sources: ["twitter:@a"],
          clusters: 1,
          countercase: "n/a",
          gate: "pass",
        },
        provenanceIds: ["twitter:@a"],
        externalEffects: [],
      }],
    }
    writeFileSync(
      join(agentRoot, "reports", runId, "decision-proposals.json"),
      `${JSON.stringify(file, null, 2)}\n`,
    )
    const state = new StateStore(join(agentRoot, "state"))
    const result = await applyDecisionProposals({
      agentRoot,
      runId,
      state,
      nowIso: "2026-07-16T12:01:00.000Z",
      policyVersion: "baseline",
      assignment: "baseline",
      blockExternalEffects: false,
      resolveGate: async () => ({
        receiptId: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        status: "pass",
        flags: ["mintable"],
      }),
      resolveMarketQuality: mqResolve(
        "sha256:5555555555555555555555555555555555555555555555555555555555555555",
      ),
    })
    expect(result.accepted).toBe(0)
    expect(result.rejected).toBe(1)
    expect(result.receipts[0]?.rejectReason).toBe("mintable-missing-classification")
  })

  it("cancels entry-pending ledger positions on drop", async () => {
    const { agentRoot, runId } = fixtureRoot()
    const state = new StateStore(join(agentRoot, "state"))
    await state.saveLedger({
      schema: 1,
      positions: [{
        schema: 1,
        positionId: "pos-d-track",
        decisionId: "d-track",
        identity,
        status: "entry-pending",
        openedAt: "2026-07-16T12:00:00.000Z",
      }],
    })
    await state.saveWatchlist({
      schema: 1,
      entries: [{
        schema: 1,
        identity,
        status: "tracking",
        addedAt: "2026-07-16T12:00:00.000Z",
        updatedAt: "2026-07-16T12:00:00.000Z",
        lastDecisionId: "d-track",
      }],
    })
    const file: DecisionProposalFile = {
      schema: 1,
      runId,
      proposedAt: "2026-07-16T13:00:00.000Z",
      proposals: [{
        schema: 1,
        proposalId: "p-drop",
        runId,
        proposedAt: "2026-07-16T13:00:00.000Z",
        card: {
          decisionId: "d-drop",
          runId,
          decisionTs: "2026-07-16T13:00:00.000Z",
          verdict: "drop",
          identity,
          thesis: "invalidated",
          horizonHours: 72,
          invalidation: "thesis broken",
          drivers: ["social"],
          confidence: 70,
          signalUse: {},
          sources: ["twitter:@a"],
          clusters: 1,
          countercase: "n/a",
          gate: "pass",
        },
        provenanceIds: ["twitter:@a"],
        externalEffects: [],
      }],
    }
    writeFileSync(
      join(agentRoot, "reports", runId, "decision-proposals.json"),
      `${JSON.stringify(file, null, 2)}\n`,
    )
    const result = await applyDecisionProposals({
      agentRoot,
      runId,
      state,
      nowIso: "2026-07-16T13:01:00.000Z",
      policyVersion: "baseline",
      assignment: "baseline",
      blockExternalEffects: false,
    })
    expect(result.accepted).toBe(1)
    expect(state.loadLedger().positions[0]?.status).toBe("censored")
    expect(state.loadLedger().positions[0]?.closedAt).toBe("2026-07-16T13:01:00.000Z")
  })

  it("downgrades tracking to watching on market-quality fail without ledger", async () => {
    const { agentRoot, runId } = fixtureRoot()
    const file: DecisionProposalFile = {
      schema: 1,
      runId,
      proposedAt: "2026-07-16T12:00:00.000Z",
      proposals: [{
        schema: 1,
        proposalId: "p-thin",
        runId,
        proposedAt: "2026-07-16T12:00:00.000Z",
        card: {
          decisionId: "d-thin",
          runId,
          decisionTs: "2026-07-16T12:00:00.000Z",
          verdict: "track",
          identity,
          thesis: "thin but safe",
          horizonHours: 72,
          invalidation: "liquidity collapse",
          drivers: ["social"],
          confidence: 55,
          signalUse: {},
          sources: ["twitter:@a"],
          clusters: 1,
          countercase: "no depth",
          gate: "pass",
          projectClassification: "memecoin",
        },
        provenanceIds: ["twitter:@a"],
        externalEffects: [],
      }],
    }
    writeFileSync(
      join(agentRoot, "reports", runId, "decision-proposals.json"),
      `${JSON.stringify(file, null, 2)}\n`,
    )
    const state = new StateStore(join(agentRoot, "state"))
    const result = await applyDecisionProposals({
      agentRoot,
      runId,
      state,
      nowIso: "2026-07-16T12:01:00.000Z",
      policyVersion: "baseline",
      assignment: "baseline",
      blockExternalEffects: false,
      resolveGate: async () => ({
        receiptId: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        status: "pass",
      }),
      resolveMarketQuality: mqResolve(
        "sha256:6666666666666666666666666666666666666666666666666666666666666666",
        "fail",
        ["liquidity"],
      ),
    })
    expect(result.accepted).toBe(1)
    expect(state.loadWatchlist().entries[0]?.status).toBe("watching")
    expect(state.loadLedger().positions).toHaveLength(0)
    expect(result.receipts[0]?.appliedWatchlistStatus).toBe("watching")
    expect(result.receipts[0]?.marketQualityReceiptId).toBe(
      "sha256:6666666666666666666666666666666666666666666666666666666666666666",
    )
    expect(result.watchingMarketQualityFail).toHaveLength(1)
  })

  it("rejects track when market-quality evidence is missing", async () => {
    const { agentRoot, runId } = fixtureRoot()
    const file: DecisionProposalFile = {
      schema: 1,
      runId,
      proposedAt: "2026-07-16T12:00:00.000Z",
      proposals: [{
        schema: 1,
        proposalId: "p-mq-miss",
        runId,
        proposedAt: "2026-07-16T12:00:00.000Z",
        card: {
          decisionId: "d-mq-miss",
          runId,
          decisionTs: "2026-07-16T12:00:00.000Z",
          verdict: "track",
          identity,
          thesis: "no mq",
          horizonHours: 72,
          invalidation: "x",
          drivers: ["social"],
          confidence: 50,
          signalUse: {},
          sources: ["twitter:@a"],
          clusters: 1,
          countercase: "n/a",
          gate: "pass",
        },
        provenanceIds: ["twitter:@a"],
        externalEffects: [],
      }],
    }
    writeFileSync(
      join(agentRoot, "reports", runId, "decision-proposals.json"),
      `${JSON.stringify(file, null, 2)}\n`,
    )
    const state = new StateStore(join(agentRoot, "state"))
    const result = await applyDecisionProposals({
      agentRoot,
      runId,
      state,
      nowIso: "2026-07-16T12:01:00.000Z",
      policyVersion: "baseline",
      assignment: "baseline",
      blockExternalEffects: false,
      resolveGate: async () => ({
        receiptId: "sha256:7777777777777777777777777777777777777777777777777777777777777777",
        status: "pass",
      }),
    })
    expect(result.accepted).toBe(0)
    expect(result.rejected).toBe(1)
    expect(result.receipts[0]?.rejectReason).toBe("market-quality-evidence-missing")
  })
})

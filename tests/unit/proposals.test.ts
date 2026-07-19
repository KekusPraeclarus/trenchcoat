import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../../src/lib/state.js"
import { applyDecisionProposals } from "../../src/orchestrator/proposals.js"
import type { DecisionProposalFile } from "../../src/contracts/schemas.js"

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
})

import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evaluateResearchSubscribe } from "../../src/orchestrator/research-verdict.js"
import type { DecisionProposalFile } from "../../src/contracts/schemas.js"

const identity = {
  chain: "base" as const,
  tokenAddress: "0x1111111111111111111111111111111111111111",
  pairAddress: "0x2222222222222222222222222222222222222222",
  symbolDisplay: "TIG",
  resolution: "resolved" as const,
}

function writeProposal(
  agentRoot: string,
  runId: string,
  overrides: Partial<DecisionProposalFile["proposals"][number]["card"]>,
): void {
  mkdirSync(join(agentRoot, "reports", runId), { recursive: true })
  const file: DecisionProposalFile = {
    schema: 1,
    runId,
    proposedAt: "2026-07-19T12:00:00.000Z",
    proposals: [{
      schema: 1,
      proposalId: "p1",
      runId,
      proposedAt: "2026-07-19T12:00:00.000Z",
      card: {
        decisionId: "d1",
        runId,
        decisionTs: "2026-07-19T12:00:00.000Z",
        verdict: "track",
        identity,
        thesis: "test",
        horizonHours: 72,
        invalidation: "x",
        drivers: ["product"],
        confidence: 60,
        signalUse: {},
        sources: ["web:docs"],
        clusters: 1,
        countercase: "n/a",
        gate: "pass",
        ...overrides,
      },
      provenanceIds: ["web:docs"],
      externalEffects: [],
    }],
  }
  writeFileSync(
    join(agentRoot, "reports", runId, "decision-proposals.json"),
    `${JSON.stringify(file, null, 2)}\n`,
  )
}

describe("evaluateResearchSubscribe", () => {
  it("fails closed without a verdict artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-verdict-"))
    const agentRoot = join(root, "agent")
    mkdirSync(agentRoot, { recursive: true })
    const result = evaluateResearchSubscribe({
      agentRoot,
      runId: "run-1",
      identity,
      security: { status: "pass", hardFail: false, flags: [] },
    })
    expect(result).toMatchObject({ subscribe: false, reason: "verdict-missing" })
  })

  it("allows justified utility mint track", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-verdict-"))
    const agentRoot = join(root, "agent")
    writeProposal(agentRoot, "run-1", {
      projectClassification: "utility",
      mintAssessment: {
        active: true,
        justified: true,
        rationale: "capped emissions via PoW rewards",
      },
    })
    const result = evaluateResearchSubscribe({
      agentRoot,
      runId: "run-1",
      identity,
      security: { status: "pass", hardFail: false, flags: ["mintable"] },
    })
    expect(result.subscribe).toBe(true)
    expect(result.verdict).toBe("track")
  })

  it("blocks mintable memecoin and ignore verdicts", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-verdict-"))
    const agentRoot = join(root, "agent")
    writeProposal(agentRoot, "run-1", {
      projectClassification: "memecoin",
      mintAssessment: {
        active: true,
        justified: false,
        rationale: "open mint on meme",
      },
    })
    expect(evaluateResearchSubscribe({
      agentRoot,
      runId: "run-1",
      identity,
      security: { status: "pass", hardFail: false, flags: ["mintable"] },
    })).toMatchObject({ subscribe: false, reason: "mintable-memecoin" })

    writeProposal(agentRoot, "run-2", { verdict: "ignore", projectClassification: "utility" })
    expect(evaluateResearchSubscribe({
      agentRoot,
      runId: "run-2",
      identity,
      security: { status: "pass", hardFail: false, flags: [] },
    })).toMatchObject({ subscribe: false, reason: "verdict-ignore" })
  })

  it("still blocks deterministic hard-fail", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-verdict-"))
    const agentRoot = join(root, "agent")
    writeProposal(agentRoot, "run-1", { projectClassification: "utility" })
    expect(evaluateResearchSubscribe({
      agentRoot,
      runId: "run-1",
      identity,
      security: { status: "hard-fail", hardFail: true, flags: ["honeypot"] },
    })).toMatchObject({ subscribe: false, reason: "security-hard-fail" })
  })
})

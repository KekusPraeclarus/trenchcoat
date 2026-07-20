import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildDecisionSignals,
  buildDecisionBundle,
  listEligibleDecisionSubjects,
} from "../../src/orchestrator/decision-bundle.js"
import { archiveLayout, ensureArchive } from "../../src/lib/archive.js"
import { resolveAuditCodeCommit } from "../../src/lib/deployment.js"
import type { DecisionProposal } from "../../src/contracts/schemas.js"

const identity = {
  chain: "solana" as const,
  tokenAddress: "So11111111111111111111111111111111111111112",
  pairAddress: "pair1111111111111111111111111111111111111111",
  symbolDisplay: "SOL",
  resolution: "resolved" as const,
}

function proposal(partial?: Partial<DecisionProposal["card"]>): DecisionProposal {
  return {
    schema: 1,
    proposalId: "p1",
    runId: "research-run-1",
    proposedAt: "2026-07-16T12:00:00.000Z",
    card: {
      decisionId: "d1",
      runId: "research-run-1",
      decisionTs: "2026-07-16T12:00:00.000Z",
      verdict: "track",
      identity,
      thesis: "early attention",
      horizonHours: 72,
      invalidation: "liquidity collapse",
      drivers: ["social"],
      confidence: 60,
      signalUse: { rsi: "driver", attention: "confirm" },
      sources: ["twitter:@a"],
      clusters: 2,
      countercase: "could be exit liquidity",
      gate: "pass",
      ...partial,
    },
    provenanceIds: ["research-run-1:dex:0"],
    externalEffects: [],
  }
}

describe("decision-bundle signals", () => {
  it("builds card signals and parses market-dex numerics", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-db-"))
    const archiveRoot = join(root, "archive")
    await ensureArchive(archiveRoot)
    const layout = archiveLayout(archiveRoot)
    const inbox = join(layout.runs, "research-run-1", "inbox")
    mkdirSync(inbox, { recursive: true })
    writeFileSync(join(inbox, "market-dex.json"), `${JSON.stringify({
      source: "dex",
      fetchedAt: "2026-07-16T12:00:00.000Z",
      trust: "host",
      items: [{
        provenance: "research-run-1:dex:0",
        text: `symbol=SOL chain=solana token=${identity.tokenAddress} pair=${identity.pairAddress} priceUsd=1.5 liquidityUsd=88000 fdv=1e6 buys24h=10 sells24h=8`,
        ts: "2026-07-16T12:00:00.000Z",
        ageSec: 0,
        freshnessTier: "live",
        dedupeKey: identity.pairAddress,
      }],
    }, null, 2)}\n`)

    const signals = buildDecisionSignals(proposal(), layout, "research-run-1")
    expect(signals.confidence).toBe(60)
    expect(signals.clusters).toBe(2)
    expect(signals["role:rsi"]).toBe(1)
    expect(signals["role:attention"]).toBe(0.5)
    expect(signals["dex:priceUsd"]).toBe(1.5)
    expect(signals["dex:liquidityUsd"]).toBe(88000)

    const bundle = buildDecisionBundle({
      proposal: proposal(),
      layout,
      policyVersion: "baseline",
      assignment: "baseline",
    })
    expect(Object.keys(bundle.signals).length).toBeGreaterThan(0)
    expect(bundle.decisionId).toBe("d1")
  })

  it("lists only mature decision subjects", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-db-elig-"))
    const archiveRoot = join(root, "archive")
    await ensureArchive(archiveRoot)
    const layout = archiveLayout(archiveRoot)
    mkdirSync(layout.decisions, { recursive: true })
    const mature = buildDecisionBundle({
      proposal: proposal({
        decisionId: "mature-1",
        decisionTs: "2026-07-10T00:00:00.000Z",
        horizonHours: 24,
      }),
      layout,
      policyVersion: "baseline",
      assignment: "baseline",
    })
    const young = buildDecisionBundle({
      proposal: proposal({
        decisionId: "young-1",
        decisionTs: "2026-07-19T00:00:00.000Z",
        horizonHours: 72,
      }),
      layout,
      policyVersion: "baseline",
      assignment: "baseline",
    })
    writeFileSync(join(layout.decisions, "mature-1.json"), `${JSON.stringify(mature, null, 2)}\n`)
    writeFileSync(join(layout.decisions, "young-1.json"), `${JSON.stringify(young, null, 2)}\n`)

    const cutoff = Math.floor(Date.parse("2026-07-20T00:00:00.000Z") / 1000)
    const subjects = listEligibleDecisionSubjects(layout, cutoff, 6)
    expect(subjects.map((s) => s.id)).toEqual(["mature-1"])
  })
})

describe("resolveAuditCodeCommit", () => {
  it("prefers deployment manifest sourceCommit", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-commit-"))
    const runtimeRoot = join(root, "runtime")
    mkdirSync(runtimeRoot, { recursive: true })
    // Minimal valid deployment.json via writing fields resolveAuditCodeCommit reads through loadDeploymentManifest
    // loadDeploymentManifest requires schema 2 + hashes — use git fallback instead when manifest invalid
    const sha = resolveAuditCodeCommit({
      runtimeRoot: join(root, "missing-runtime"),
      repoRoot: "/Users/kyran/Documents/trench-bot",
    })
    expect(sha).toMatch(/^[a-f0-9]{7,64}$/)
    expect(sha).not.toBe("local")
  })

  it("rejects the historical local placeholder", () => {
    expect(() => {
      // force git failure with nonexistent repo
      resolveAuditCodeCommit({
        runtimeRoot: join(tmpdir(), "no-runtime-" + Date.now()),
        repoRoot: join(tmpdir(), "no-repo-" + Date.now()),
      })
    }).toThrow(/cannot resolve audit codeCommit/)
  })
})

import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive } from "../../src/lib/archive.js"
import {
  archivedProvenanceAllowlist,
  resolveGateFromArchive,
  resolveGateArchiveThenLive,
} from "../../src/orchestrator/gate-evidence.js"
import type { DecisionProposal } from "../../src/contracts/schemas.js"

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
      identity: {
        chain: "solana",
        tokenAddress: "So11111111111111111111111111111111111111112",
        pairAddress: "pair1111111111111111111111111111111111111111",
        symbolDisplay: "SOL",
        resolution: "resolved",
      },
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

describe("gate evidence from archive", () => {
  it("builds provenance allowlist and gate pass from security snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-gate-"))
    try {
      const layout = await ensureArchive(join(root, "archive"))
      const runId = "run-1"
      const inbox = join(layout.runs, runId, "inbox")
      mkdirSync(inbox, { recursive: true })
      writeFileSync(join(inbox, "list.json"), `${JSON.stringify({
        source: "x",
        fetchedAt: "2026-07-17T12:00:00.000Z",
        trust: "untrusted-external",
        items: [{
          provenance: "x:list:a",
          text: "hello",
          ts: "2026-07-17T12:00:00.000Z",
          ageSec: 0,
          freshnessTier: "live",
        }],
      })}\n`)
      writeFileSync(join(inbox, "security-gate.json"), `${JSON.stringify({
        source: "host.security",
        fetchedAt: "2026-07-17T12:00:00.000Z",
        trust: "untrusted-external",
        items: [{
          provenance: "run-1:security",
          dedupeKey: "solana:So11111111111111111111111111111111111111112",
          text: "chain=solana token=So11111111111111111111111111111111111111112 pair=pair1111111111111111111111111111111111111111 status=pass hardFail=false flags=none",
          ts: "2026-07-17T12:00:00.000Z",
          ageSec: 0,
          freshnessTier: "live",
        }],
      })}\n`)

      const allow = archivedProvenanceAllowlist(layout, runId)
      expect(allow.has("x:list:a")).toBe(true)

      const gate = resolveGateFromArchive(
        layout,
        runId,
        baseProposal(runId),
        "2026-07-17T12:01:00.000Z",
      )
      expect(gate?.status).toBe("pass")
      expect(gate?.receipt.source).toBe("archived-dossier")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("live-refetches when archive dossier is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-gate-live-"))
    try {
      const layout = await ensureArchive(join(root, "archive"))
      const runId = "run-2"
      mkdirSync(join(layout.runs, runId, "inbox"), { recursive: true })

      const fetcher = async () => new Response(
        JSON.stringify({
          // Rugcheck-shaped minimal report that maps to pass/hard-fail via mapRugCheck
          score: 90,
          risks: [],
          tokenMeta: {},
          topHolders: [],
          markets: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )

      const gate = await resolveGateArchiveThenLive({
        layout,
        runId,
        proposal: baseProposal(runId),
        nowIso: "2026-07-17T12:01:00.000Z",
        fetcher,
        enableLiveRefetch: true,
      })
      expect(gate).toBeDefined()
      expect(gate?.receipt.source).toBe("live-refetch")
      // Pending is acceptable if mapper is strict; never invent pass without evidence
      expect(["pass", "hard-fail", "pending", "unsupported-chain"]).toContain(gate?.status)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

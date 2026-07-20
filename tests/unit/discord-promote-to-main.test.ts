import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../../src/lib/state.js"
import { promoteDiscordTrackToMain } from "../../src/discord/promote-to-main.js"
import type { DecisionProposalFile } from "../../src/contracts/schemas.js"

const identity = {
  chain: "solana" as const,
  tokenAddress: "So11111111111111111111111111111111111111112",
  pairAddress: "pair1111111111111111111111111111111111111111",
  symbolDisplay: "SOL",
  resolution: "resolved" as const,
}

describe("promoteDiscordTrackToMain", () => {
  it("skips when no track verdict", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-promote-skip-"))
    try {
      const discordAgent = join(root, "discord", "agent")
      mkdirSync(discordAgent, { recursive: true })
      const result = await promoteDiscordTrackToMain({
        discordAgentRoot: discordAgent,
        discordArchiveRoot: join(root, "discord", "archive"),
        runId: "discord-research-1",
        identity,
        security: { status: "pass", hardFail: false, flags: [] },
        mainAgentRoot: join(root, "main", "agent"),
      })
      expect(result).toMatchObject({ promoted: false, reason: "verdict-missing" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("promotes validated track onto main watchlist", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-promote-ok-"))
    try {
      const runId = "discord-research-1"
      const discordAgent = join(root, "discord", "agent")
      const discordArchive = join(root, "discord", "archive")
      const mainAgent = join(root, "main", "agent")
      mkdirSync(join(discordAgent, "reports", runId), { recursive: true })
      mkdirSync(join(mainAgent, "state"), { recursive: true })

      const file: DecisionProposalFile = {
        schema: 1,
        runId,
        proposedAt: "2026-07-20T12:00:00.000Z",
        proposals: [{
          schema: 1,
          proposalId: "p1",
          runId,
          proposedAt: "2026-07-20T12:00:00.000Z",
          card: {
            decisionId: "d1",
            runId,
            decisionTs: "2026-07-20T12:00:00.000Z",
            verdict: "track",
            identity,
            thesis: "discord research track",
            horizonHours: 72,
            invalidation: "liquidity collapse",
            drivers: ["product"],
            confidence: 70,
            signalUse: {},
            sources: ["x:list:a"],
            clusters: 1,
            countercase: "could be exit",
            gate: "pass",
            projectClassification: "utility",
          },
          provenanceIds: ["x:list:a"],
          externalEffects: [],
        }],
      }
      writeFileSync(
        join(discordAgent, "reports", runId, "decision-proposals.json"),
        `${JSON.stringify(file, null, 2)}\n`,
      )

      const inbox = join(discordArchive, "runs", runId, "inbox")
      mkdirSync(inbox, { recursive: true })
      writeFileSync(join(inbox, "list.json"), `${JSON.stringify({
        source: "x",
        fetchedAt: "2026-07-20T12:00:00.000Z",
        trust: "untrusted-external",
        items: [{
          provenance: "x:list:a",
          text: "hello",
          ts: "2026-07-20T12:00:00.000Z",
          ageSec: 0,
          freshnessTier: "live",
        }],
      })}\n`)
      writeFileSync(join(inbox, "security-gate.json"), `${JSON.stringify({
        source: "host.security",
        fetchedAt: "2026-07-20T12:00:00.000Z",
        trust: "untrusted-external",
        items: [{
          provenance: "run-1:security",
          dedupeKey: `solana:${identity.tokenAddress}`,
          text: `chain=solana token=${identity.tokenAddress} pair=${identity.pairAddress} status=pass hardFail=false flags=none`,
          ts: "2026-07-20T12:00:00.000Z",
          ageSec: 0,
          freshnessTier: "live",
        }],
      })}\n`)

      const result = await promoteDiscordTrackToMain({
        discordAgentRoot: discordAgent,
        discordArchiveRoot: discordArchive,
        runId,
        identity,
        security: { status: "pass", hardFail: false, flags: [] },
        nowIso: "2026-07-20T12:01:00.000Z",
        mainAgentRoot: mainAgent,
      })
      expect(result.promoted).toBe(true)

      const state = new StateStore(join(mainAgent, "state"))
      expect(state.loadWatchlist().entries[0]?.status).toBe("tracking")
      expect(state.loadLedger().positions[0]?.status).toBe("entry-pending")
      expect(state.readDecisions()).toContain("d1")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

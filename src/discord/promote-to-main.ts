/**
 * Host bridge: Discord research track verdicts → main agent watchlist.
 * Discord agent remains isolated; only this host path mutates main state.
 */

import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { systemClock } from "../lib/clock.js"
import { log } from "../lib/log.js"
import { WorkspaceLock, agentLockPath } from "../lib/lock.js"
import { StateStore } from "../lib/state.js"
import { ensureArchive, runArchiveDir, writeJsonRecordFsync } from "../lib/archive.js"
import type { CanonicalIdentity, GateReceipt } from "../contracts/schemas.js"
import { applyDecisionProposals } from "../orchestrator/proposals.js"
import { evaluateResearchSubscribe } from "../orchestrator/research-verdict.js"
import {
  archivedProvenanceAllowlist,
  resolveGateArchiveThenLive,
} from "../orchestrator/gate-evidence.js"
import {
  resolveMarketQualityFromArchive,
  writeMarketQualityReceipt,
} from "../orchestrator/market-quality-evidence.js"
import { reconcileIndex } from "../orchestrator/index-reconcile.js"

export type DiscordMainPromoteResult = Readonly<{
  promoted: boolean
  reason?: string
  accepted?: number
}>

export function mainAgentRoot(home = join(homedir(), ".trenchcoat")): string {
  return existsSync(join(home, "agent"))
    ? join(home, "agent")
    : join(process.cwd(), "agent")
}

/**
 * Promote a validated Discord `track` proposal onto the main watchlist/ledger.
 * Non-blocking on main `.lock` — busy skips without affecting Discord subscribe.
 */
export async function promoteDiscordTrackToMain(args: Readonly<{
  discordAgentRoot: string
  discordArchiveRoot: string
  runId: string
  identity: CanonicalIdentity
  security: Readonly<{
    status: string
    hardFail: boolean
    flags: readonly string[]
  }>
  nowIso?: string
  mainAgentRoot?: string
}>): Promise<DiscordMainPromoteResult> {
  const nowIso = args.nowIso ?? systemClock.nowIso()
  const decision = evaluateResearchSubscribe({
    agentRoot: args.discordAgentRoot,
    runId: args.runId,
    identity: args.identity,
    security: args.security,
  })
  if (!decision.subscribe || !decision.proposal) {
    return { promoted: false, reason: decision.reason ?? "not-track" }
  }

  const mainRoot = args.mainAgentRoot ?? mainAgentRoot()
  if (!existsSync(join(mainRoot, "state"))) {
    return { promoted: false, reason: "main-state-missing" }
  }

  const lock = new WorkspaceLock(agentLockPath(mainRoot))
  if (!lock.tryAcquire()) {
    return { promoted: false, reason: "main-lock-busy" }
  }

  try {
    const archive = await ensureArchive(args.discordArchiveRoot)
    const allowedProvenanceIds = archivedProvenanceAllowlist(archive, args.runId)
    const state = new StateStore(join(mainRoot, "state"))
    const runDir = runArchiveDir(archive, args.runId)
    mkdirSync(join(runDir, "gate-receipts"), { recursive: true, mode: 0o700 })

    const resolveGate = async (
      proposal: Parameters<NonNullable<Parameters<typeof applyDecisionProposals>[0]["resolveGate"]>>[0],
    ) => {
      const resolved = await resolveGateArchiveThenLive({
        layout: archive,
        runId: args.runId,
        proposal,
        nowIso,
        fetcher: fetch,
        enableLiveRefetch: true,
      })
      if (!resolved) return undefined
      const receipt: GateReceipt = resolved.receipt
      await writeJsonRecordFsync(
        join(runDir, "gate-receipts", `${receipt.receiptId.slice(7, 23)}.json`),
        receipt as never,
      )
      return {
        receiptId: resolved.receiptId,
        status: resolved.status,
        flags: resolved.receipt.flags,
      }
    }

    const resolveMarketQuality = async (
      proposal: Parameters<NonNullable<
        Parameters<typeof applyDecisionProposals>[0]["resolveMarketQuality"]
      >>[0],
    ) => {
      const resolved = resolveMarketQualityFromArchive(
        archive,
        args.runId,
        proposal,
        nowIso,
      )
      if (!resolved) return undefined
      await writeMarketQualityReceipt(archive, args.runId, resolved.receipt)
      return resolved
    }

    const applied = await applyDecisionProposals({
      agentRoot: args.discordAgentRoot,
      runId: args.runId,
      state,
      nowIso,
      policyVersion: "discord-research",
      assignment: "baseline",
      blockExternalEffects: true,
      archiveRoot: args.discordArchiveRoot,
      allowedProvenanceIds,
      proposalIds: new Set([decision.proposal.proposalId]),
      resolveGate,
      resolveMarketQuality,
      commit: true,
    })

    if (applied.accepted > 0) {
      await reconcileIndex({
        agentRoot: mainRoot,
        state,
        nowIso,
      })
      log.info("discord promote to main", {
        runId: args.runId,
        accepted: applied.accepted,
        chain: args.identity.chain,
        token: args.identity.tokenAddress.slice(0, 8),
      })
      return { promoted: true, accepted: applied.accepted }
    }

    const rejectReason = applied.receipts.find((r) => !r.accepted)?.rejectReason
    return {
      promoted: false,
      reason: rejectReason ?? "proposal-rejected",
      accepted: 0,
    }
  } catch (error) {
    log.warn("discord promote to main failed", {
      runId: args.runId,
      error: error instanceof Error ? error.message : "unknown",
    })
    return {
      promoted: false,
      reason: error instanceof Error ? error.message : "promote-failed",
    }
  } finally {
    lock.release()
  }
}

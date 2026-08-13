import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadConfig, type TrenchcoatConfig } from "../lib/config.js"
import { StateStore } from "../lib/state.js"
import { systemClock } from "../lib/clock.js"
import { sha256Json } from "../lib/canonical-json.js"
import {
  applyPumpEngagementChoices,
  parsePumpEngagementProposal,
  pumpLikesInWindow,
  type PumpEngagementCaps,
} from "../social/pump-engagement.js"
import { loadPumpFypEligibleManifest } from "./pump-fyp-eligible.js"
import {
  pumpBotHealthEscalation,
  recordPumpBotHealth,
} from "./pump-bot-health.js"
import { PumpEngagementSession } from "../collectors/pump/engagement.js"
import type {
  PumpEngagementDecision,
  PumpEngagementFile,
  PumpEngagementReceipt,
} from "../contracts/schemas.js"

export function pumpEngagementCapsFromConfig(config: TrenchcoatConfig): PumpEngagementCaps {
  return config.pump.engagement
}

export type PumpEngagementRunReport = Readonly<{
  proposed: number
  accepted: number
  rejected: number
  executed: number
  verified: number
  ambiguous: number
  dryRun: boolean
  blockedExternalEffects: boolean
  shadowMode: boolean
  decisions: readonly PumpEngagementDecision[]
  receipts: readonly PumpEngagementReceipt[]
  malformed?: "json" | "schema" | "run-id-mismatch"
}>

function emptyReport(
  dryRun: boolean,
  blockedExternalEffects: boolean,
  shadowMode: boolean,
): PumpEngagementRunReport {
  return {
    proposed: 0,
    accepted: 0,
    rejected: 0,
    executed: 0,
    verified: 0,
    ambiguous: 0,
    dryRun,
    blockedExternalEffects,
    shadowMode,
    decisions: [],
    receipts: [],
  }
}

function buildReceipt(args: Readonly<{
  actionId: string
  action: PumpEngagementReceipt["action"]
  target: string
  nowIso: string
  verified: boolean
  ambiguous: boolean
  outcome?: PumpEngagementReceipt["outcome"]
  error?: string
}>): PumpEngagementReceipt {
  return {
    schema: 1,
    receiptId: sha256Json({
      actionId: args.actionId,
      attemptedAt: args.nowIso,
      target: args.target,
    }),
    actionId: args.actionId as `sha256:${string}`,
    action: args.action,
    target: args.target,
    attemptedAt: args.nowIso,
    verified: args.verified,
    ambiguous: args.ambiguous,
    ...(args.outcome ? { outcome: args.outcome } : {}),
    ...(args.error ? { error: args.error } : {}),
  }
}

export async function processPumpScanEngagement(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  runId: string
  dryRun?: boolean
  execute?: boolean
  blockExternalEffects?: boolean
  nowIso?: string
  config?: TrenchcoatConfig
  driver?: Pick<PumpEngagementSession, "like" | "follow" | "unfollow" | "close">
}>): Promise<PumpEngagementRunReport> {
  const config = args.config ?? loadConfig()
  const caps = pumpEngagementCapsFromConfig(config)
  const nowIso = args.nowIso ?? systemClock.nowIso()
  const state = new StateStore(join(args.agentRoot, "state"))
  const proposalPath = join(args.agentRoot, "reports", args.runId, "pump-engagement.json")
  const shadowMode = config.pump.shadow_mode
  const blocked = Boolean(args.blockExternalEffects) || shadowMode

  if (!existsSync(proposalPath) || !caps.enabled || !config.pump.enabled) {
    return emptyReport(Boolean(args.dryRun), blocked, shadowMode)
  }

  let proposalRaw: unknown
  try {
    proposalRaw = JSON.parse(readFileSync(proposalPath, "utf8"))
  } catch {
    return { ...emptyReport(Boolean(args.dryRun), blocked, shadowMode), malformed: "json" }
  }

  let proposal
  try {
    proposal = parsePumpEngagementProposal(proposalRaw)
  } catch {
    return { ...emptyReport(Boolean(args.dryRun), blocked, shadowMode), malformed: "schema" }
  }

  if (proposal.runId !== args.runId) {
    return {
      ...emptyReport(Boolean(args.dryRun), blocked, shadowMode),
      malformed: "run-id-mismatch",
    }
  }

  const current = state.loadPumpEngagement()
  const manifest = loadPumpFypEligibleManifest(args.agentRoot, args.archiveRoot, args.runId)
  const applied = applyPumpEngagementChoices({
    proposal,
    state: current,
    caps,
    nowIso,
    eligibleItemIds: (manifest?.items ?? []).map((item) => item.itemId),
    eligibleAuthors: (manifest?.items ?? []).map((item) => item.author),
  })

  if (args.dryRun) {
    return {
      proposed: proposal.items.length,
      accepted: applied.accepted.length,
      rejected: applied.rejected.length,
      executed: 0,
      verified: 0,
      ambiguous: 0,
      dryRun: true,
      blockedExternalEffects: blocked,
      shadowMode,
      decisions: applied.decisions,
      receipts: [],
    }
  }

  const shouldMutate = !blocked && args.execute !== false && applied.accepted.length > 0
  const receipts: PumpEngagementReceipt[] = []
  let next: PumpEngagementFile = applied.nextState

  if (shouldMutate) {
    const driver = args.driver ?? new PumpEngagementSession()
    try {
      for (const decision of applied.accepted) {
        let result: { verified: boolean, ambiguous: boolean }
        try {
          if (decision.action === "like") result = await driver.like(decision.target)
          else if (decision.action === "follow") result = await driver.follow(decision.target)
          else result = await driver.unfollow(decision.target)
        } catch (error) {
          result = {
            verified: false,
            ambiguous: true,
          }
          receipts.push(buildReceipt({
            actionId: decision.actionId,
            action: decision.action,
            target: decision.target,
            nowIso,
            verified: false,
            ambiguous: true,
            outcome: "ambiguous",
            error: error instanceof Error ? error.message : "engagement failed",
          }))
          continue
        }
        receipts.push(buildReceipt({
          actionId: decision.actionId,
          action: decision.action,
          target: decision.target,
          nowIso,
          verified: result.verified,
          ambiguous: result.ambiguous,
          outcome: result.verified ? "verified" : (result.ambiguous ? "ambiguous" : "failed-before-mutation"),
        }))
      }
    } finally {
      await driver.close().catch(() => undefined)
    }

    const liked = new Set(current.likedItemIds)
    const followed = new Set(current.followedHandles)
    const lastLikedAt = { ...current.lastLikedAt }
    const lastFollowedAt = { ...current.lastFollowedAt }
    const verifiedIds = new Set(
      receipts.filter((r) => r.verified && !r.ambiguous).map((r) => r.actionId),
    )
    for (const decision of applied.accepted) {
      if (!verifiedIds.has(decision.actionId)) continue
      if (decision.action === "like") {
        liked.add(decision.target)
        lastLikedAt[decision.target] = nowIso
      } else if (decision.action === "follow") {
        followed.add(decision.target)
        lastFollowedAt[decision.target] = nowIso
      } else {
        followed.delete(decision.target)
      }
    }
    next = {
      ...applied.nextState,
      likedItemIds: [...liked],
      followedHandles: [...followed],
      lastLikedAt,
      lastFollowedAt,
      receipts: [...applied.nextState.receipts, ...receipts],
      pendingActionIds: applied.nextState.pendingActionIds.filter((id) => !verifiedIds.has(id)),
    }
    await recordPumpBotHealth({
      state,
      nowIso,
      runId: args.runId,
      receipts,
    })
  } else {
    receipts.push(...applied.accepted.map((decision) => buildReceipt({
      actionId: decision.actionId,
      action: decision.action,
      target: decision.target,
      nowIso,
      verified: false,
      ambiguous: false,
      outcome: "failed-before-mutation",
      error: shadowMode ? "shadow-mode" : "blocked-external-effects",
    })))
    next = {
      ...applied.nextState,
      pendingActionIds: current.pendingActionIds,
      receipts: [...applied.nextState.receipts, ...receipts],
    }
  }

  await state.savePumpEngagement(next)

  const archiveDir = join(args.archiveRoot, "pump-engagement", args.runId)
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(archiveDir, "decisions.json"), `${JSON.stringify(applied.decisions, null, 2)}\n`)
  writeFileSync(join(archiveDir, "receipts.json"), `${JSON.stringify(receipts, null, 2)}\n`)

  const verified = receipts.filter((r) => r.verified && !r.ambiguous).length
  const ambiguous = receipts.filter((r) => r.ambiguous).length
  return {
    proposed: proposal.items.length,
    accepted: applied.accepted.length,
    rejected: applied.rejected.length,
    executed: shouldMutate ? receipts.length : 0,
    verified,
    ambiguous,
    dryRun: false,
    blockedExternalEffects: blocked,
    shadowMode,
    decisions: applied.decisions,
    receipts,
  }
}

export function probePumpEngagementSummary(
  agentRoot: string,
  config: TrenchcoatConfig,
): unknown {
  const state = new StateStore(join(agentRoot, "state"))
  const file = state.loadPumpEngagement()
  const nowIso = systemClock.nowIso()
  const botHealth = state.loadPumpBotHealth(nowIso)
  return {
    enabled: config.pump.engagement.enabled,
    likeThrottle: {
      max: config.pump.engagement.likes_per_window,
      windowMinutes: config.pump.engagement.like_window_minutes,
      usedInWindow: pumpLikesInWindow(
        file,
        nowIso,
        config.pump.engagement.like_window_minutes,
      ),
    },
    followed: file.followedHandles.length,
    liked: file.likedItemIds.length,
    pending: file.pendingActionIds.length,
    daily: file.daily,
    decisions: file.decisions.length,
    receipts: file.receipts.length,
    botHealth,
    botHealthEscalation: pumpBotHealthEscalation(botHealth),
  }
}

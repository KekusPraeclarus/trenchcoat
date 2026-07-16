import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadConfig, type TrenchcoatConfig } from "../lib/config.js"
import { StateStore } from "../lib/state.js"
import { systemClock } from "../lib/clock.js"
import {
  parseEngagementProposal,
  applyEngagementChoices,
  likesInWindow,
  type EngagementCaps,
} from "../social/x-engagement.js"
import { executeEngagementActions } from "../collectors/twitter/engagement.js"
import type {
  XEngagementDecision,
  XEngagementFile,
  XEngagementReceipt,
} from "../contracts/schemas.js"

export function engagementCapsFromConfig(config: TrenchcoatConfig): EngagementCaps {
  return config.twitter.engagement
}

export type EngagementRunReport = Readonly<{
  proposed: number
  accepted: number
  rejected: number
  executed: number
  verified: number
  ambiguous: number
  dryRun: boolean
  decisions: readonly XEngagementDecision[]
  receipts: readonly XEngagementReceipt[]
}>

export async function processListScanEngagement(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  runId: string
  dryRun?: boolean
  execute?: boolean
  nowIso?: string
  headless?: boolean
}>): Promise<EngagementRunReport> {
  const config = loadConfig()
  const caps = engagementCapsFromConfig(config)
  const nowIso = args.nowIso ?? systemClock.nowIso()
  const state = new StateStore(join(args.agentRoot, "state"))
  const proposalPath = join(args.agentRoot, "reports", args.runId, "x-engagement.json")

  if (!existsSync(proposalPath) || !caps.enabled) {
    return {
      proposed: 0,
      accepted: 0,
      rejected: 0,
      executed: 0,
      verified: 0,
      ambiguous: 0,
      dryRun: Boolean(args.dryRun),
      decisions: [],
      receipts: [],
    }
  }

  let proposalRaw: unknown
  try {
    proposalRaw = JSON.parse(readFileSync(proposalPath, "utf8"))
  } catch {
    return emptyReport(Boolean(args.dryRun))
  }

  let proposal
  try {
    proposal = parseEngagementProposal(proposalRaw)
  } catch {
    return emptyReport(Boolean(args.dryRun))
  }

  if (proposal.runId !== args.runId) {
    return emptyReport(Boolean(args.dryRun))
  }

  const current = state.loadXEngagement()
  const applied = applyEngagementChoices({
    proposal,
    state: current,
    caps,
    nowIso,
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
      decisions: applied.decisions,
      receipts: [],
    }
  }

  await state.saveXEngagement(applied.nextState)

  let receipts: readonly XEngagementReceipt[] = []
  let verifiedActionIds: readonly `sha256:${string}`[] = []
  let ambiguousActionIds: readonly `sha256:${string}`[] = []

  if (args.execute !== false && applied.accepted.length > 0) {
    const executed = await executeEngagementActions({
      accepted: applied.accepted,
      nowIso,
      ...(args.headless === undefined ? {} : { headless: args.headless }),
    })
    receipts = executed.receipts
    verifiedActionIds = executed.verifiedActionIds
    ambiguousActionIds = executed.ambiguousActionIds

    const after = state.loadXEngagement()
    const followed = new Set(after.followedHandles.map((h) => h.toLowerCase()))
    const liked = new Set(after.likedPostIds)
    const lastLikedAt = { ...after.lastLikedAt }
    const lastFollowedAt = { ...after.lastFollowedAt }
    const verifiedSet = new Set(verifiedActionIds)

    for (const decision of applied.accepted) {
      if (!verifiedSet.has(decision.actionId as `sha256:${string}`)) continue
      if (decision.action === "like") {
        liked.add(decision.target)
        lastLikedAt[decision.target] = nowIso
      } else if (decision.action === "follow") {
        followed.add(decision.target.toLowerCase())
        lastFollowedAt[decision.target.toLowerCase()] = nowIso
      } else {
        followed.delete(decision.target.toLowerCase())
      }
    }

    const next: XEngagementFile = {
      ...after,
      followedHandles: [...followed].sort(),
      likedPostIds: [...liked].sort(),
      lastLikedAt,
      lastFollowedAt,
      receipts: [...after.receipts, ...receipts],
      pendingActionIds: after.pendingActionIds.filter((id) => (
        !verifiedActionIds.includes(id as `sha256:${string}`)
      )),
    }
    await state.saveXEngagement(next)
  }

  const archiveDir = join(args.archiveRoot, "x-engagement", args.runId)
  mkdirSync(archiveDir, { recursive: true })
  writeFileSync(
    join(archiveDir, "decisions.json"),
    `${JSON.stringify(applied.decisions, null, 2)}\n`,
  )
  writeFileSync(
    join(archiveDir, "receipts.json"),
    `${JSON.stringify(receipts, null, 2)}\n`,
  )

  return {
    proposed: proposal.items.length,
    accepted: applied.accepted.length,
    rejected: applied.rejected.length,
    executed: receipts.length,
    verified: verifiedActionIds.length,
    ambiguous: ambiguousActionIds.length,
    dryRun: false,
    decisions: applied.decisions,
    receipts,
  }
}

function emptyReport(dryRun: boolean): EngagementRunReport {
  return {
    proposed: 0,
    accepted: 0,
    rejected: 0,
    executed: 0,
    verified: 0,
    ambiguous: 0,
    dryRun,
    decisions: [],
    receipts: [],
  }
}

export function probeEngagementSummary(agentRoot: string, config: TrenchcoatConfig): unknown {
  const state = new StateStore(join(agentRoot, "state"))
  const file = state.loadXEngagement()
  const nowIso = systemClock.nowIso()
  return {
    enabled: config.twitter.engagement.enabled,
    likeThrottle: {
      max: config.twitter.engagement.likes_per_window,
      windowMinutes: config.twitter.engagement.like_window_minutes,
      usedInWindow: likesInWindow(
        file,
        nowIso,
        config.twitter.engagement.like_window_minutes,
      ),
    },
    followed: file.followedHandles.length,
    liked: file.likedPostIds.length,
    pending: file.pendingActionIds.length,
    daily: file.daily,
    decisions: file.decisions.length,
    receipts: file.receipts.length,
  }
}

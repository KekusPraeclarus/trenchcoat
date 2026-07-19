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
import {
  buildEngagementReceipt,
  executeEngagementActions,
  openPlaywrightEngagementSession,
  type EngagementDriver,
} from "../collectors/twitter/engagement.js"
import type {
  XEngagementDecision,
  XEngagementFile,
  XEngagementReceipt,
} from "../contracts/schemas.js"
import { loadXFypEligibleManifest } from "./x-fyp-eligible.js"
import {
  recordEngagementExecutionHealth,
  recoverXBotHealth,
  xBotHealthEscalation,
} from "./x-bot-health.js"
import { log } from "../lib/log.js"

/** Pending actions older than this may be cleared after a successful negative verify. */
export const PENDING_ABSENT_COOLDOWN_MS = 15 * 60_000

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
  blockedExternalEffects: boolean
  botHealthBlocked?: boolean
  fypEligiblePosts: number
  reconciled?: number
  decisions: readonly XEngagementDecision[]
  receipts: readonly XEngagementReceipt[]
  malformed?: "json" | "schema" | "run-id-mismatch"
}>

export type PendingReconcileReport = Readonly<{
  settled: number
  clearedAbsent: number
  leftPending: number
  receipts: readonly XEngagementReceipt[]
  nextState: XEngagementFile
  healthCleared: boolean
}>

function resolveFypBinding(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  runId: string
  fypPosts?: readonly Readonly<{ id: string, author: string, text?: string }>[]
}>): Readonly<{ postIds: readonly string[], authors: readonly string[], count: number }> {
  if (args.fypPosts && args.fypPosts.length > 0) {
    return {
      postIds: args.fypPosts.map((post) => post.id),
      authors: args.fypPosts.map((post) => post.author),
      count: args.fypPosts.length,
    }
  }
  const manifest = loadXFypEligibleManifest(args.agentRoot, args.archiveRoot, args.runId)
  if (!manifest) {
    return { postIds: [], authors: [], count: 0 }
  }
  return {
    postIds: manifest.posts.map((post) => post.postId),
    authors: manifest.posts.map((post) => post.author),
    count: manifest.posts.length,
  }
}

function decisionForPending(
  file: XEngagementFile,
  actionId: string,
): XEngagementDecision | undefined {
  for (let i = file.decisions.length - 1; i >= 0; i -= 1) {
    const decision = file.decisions[i]!
    if (decision.actionId === actionId && decision.accepted) return decision
  }
  return undefined
}

function pendingAgeMs(file: XEngagementFile, actionId: string, nowIso: string): number {
  const decision = decisionForPending(file, actionId)
  const anchor = decision?.decidedAt
    ?? file.receipts.filter((r) => r.actionId === actionId).at(-1)?.attemptedAt
  if (!anchor) return Number.POSITIVE_INFINITY
  const age = Date.parse(nowIso) - Date.parse(anchor)
  return Number.isFinite(age) ? age : Number.POSITIVE_INFINITY
}

/**
 * Read-only reconcile of old pending actions. Never re-clicks — a duplicate
 * mutation could unlike/unfollow. Settle when desired state is present; clear
 * as definitively absent only after successful negative verification + cooldown.
 */
export async function reconcilePendingEngagement(args: Readonly<{
  state: XEngagementFile
  nowIso: string
  runId: string
  driver?: Pick<EngagementDriver, "verifyLiked" | "verifyFollowing">
  cooldownMs?: number
}>): Promise<PendingReconcileReport> {
  const cooldownMs = args.cooldownMs ?? PENDING_ABSENT_COOLDOWN_MS
  const pending = [...args.state.pendingActionIds]
  if (pending.length === 0 || !args.driver) {
    return {
      settled: 0,
      clearedAbsent: 0,
      leftPending: pending.length,
      receipts: [],
      nextState: args.state,
      healthCleared: false,
    }
  }

  const receipts: XEngagementReceipt[] = []
  const settledIds = new Set<string>()
  const clearedIds = new Set<string>()
  const liked = new Set(args.state.likedPostIds)
  const followed = new Set(args.state.followedHandles.map((h) => h.toLowerCase()))
  const lastLikedAt = { ...args.state.lastLikedAt }
  const lastFollowedAt = { ...args.state.lastFollowedAt }

  for (const actionId of pending) {
    const decision = decisionForPending(args.state, actionId)
    if (!decision) {
      // Orphan pending id — leave it rather than invent a clear
      continue
    }

    try {
      if (decision.action === "like") {
        if (!args.driver.verifyLiked) continue
        const present = await args.driver.verifyLiked(decision.target)
        if (present) {
          liked.add(decision.target)
          lastLikedAt[decision.target] = args.nowIso
          settledIds.add(actionId)
          receipts.push(buildEngagementReceipt({
            actionId: actionId as `sha256:${string}`,
            action: "like",
            target: decision.target,
            nowIso: args.nowIso,
            outcome: "already-satisfied",
            verified: true,
            ambiguous: false,
          }))
          continue
        }
        if (pendingAgeMs(args.state, actionId, args.nowIso) >= cooldownMs) {
          clearedIds.add(actionId)
          receipts.push(buildEngagementReceipt({
            actionId: actionId as `sha256:${string}`,
            action: "like",
            target: decision.target,
            nowIso: args.nowIso,
            outcome: "failed-before-mutation",
            verified: false,
            ambiguous: false,
            verificationError: "pending-absent-after-cooldown",
          }))
        }
        continue
      }

      if (decision.action === "follow") {
        if (!args.driver.verifyFollowing) continue
        const present = await args.driver.verifyFollowing(decision.target)
        if (present) {
          followed.add(decision.target.toLowerCase())
          lastFollowedAt[decision.target.toLowerCase()] = args.nowIso
          settledIds.add(actionId)
          receipts.push(buildEngagementReceipt({
            actionId: actionId as `sha256:${string}`,
            action: "follow",
            target: decision.target,
            nowIso: args.nowIso,
            outcome: "already-satisfied",
            verified: true,
            ambiguous: false,
          }))
          continue
        }
        if (pendingAgeMs(args.state, actionId, args.nowIso) >= cooldownMs) {
          clearedIds.add(actionId)
          receipts.push(buildEngagementReceipt({
            actionId: actionId as `sha256:${string}`,
            action: "follow",
            target: decision.target,
            nowIso: args.nowIso,
            outcome: "failed-before-mutation",
            verified: false,
            ambiguous: false,
            verificationError: "pending-absent-after-cooldown",
          }))
        }
        continue
      }

      // unfollow: desired state is NOT following
      if (!args.driver.verifyFollowing) continue
      const stillFollowing = await args.driver.verifyFollowing(decision.target)
      if (!stillFollowing) {
        followed.delete(decision.target.toLowerCase())
        settledIds.add(actionId)
        receipts.push(buildEngagementReceipt({
          actionId: actionId as `sha256:${string}`,
          action: "unfollow",
          target: decision.target,
          nowIso: args.nowIso,
          outcome: "already-satisfied",
          verified: true,
          ambiguous: false,
        }))
        continue
      }
      if (pendingAgeMs(args.state, actionId, args.nowIso) >= cooldownMs) {
        // Still following after cooldown — leave pending; do not re-click
        continue
      }
    } catch {
      // Probe failed — leave pending rather than invent absence
      continue
    }
  }

  const removed = new Set([...settledIds, ...clearedIds])
  const nextState: XEngagementFile = {
    ...args.state,
    followedHandles: [...followed].sort(),
    likedPostIds: [...liked].sort(),
    lastLikedAt,
    lastFollowedAt,
    receipts: [...args.state.receipts, ...receipts],
    pendingActionIds: args.state.pendingActionIds.filter((id) => !removed.has(id)),
  }

  return {
    settled: settledIds.size,
    clearedAbsent: clearedIds.size,
    leftPending: nextState.pendingActionIds.length,
    receipts,
    nextState,
    healthCleared: settledIds.size > 0,
  }
}

function archiveBotHealthBlocked(args: Readonly<{
  archiveRoot: string
  runId: string
  nowIso: string
  consecutiveFailures: number
  lastError?: string
}>): void {
  const archiveDir = join(args.archiveRoot, "x-engagement", args.runId)
  mkdirSync(archiveDir, { recursive: true })
  writeFileSync(
    join(archiveDir, "bot-health-blocked.json"),
    `${JSON.stringify({
      schema: 1,
      outcome: "bot-health-blocked",
      runId: args.runId,
      blockedAt: args.nowIso,
      consecutiveFailures: args.consecutiveFailures,
      ...(args.lastError ? { lastError: args.lastError.slice(0, 500) } : {}),
    }, null, 2)}\n`,
  )
}

export async function processListScanEngagement(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  runId: string
  dryRun?: boolean
  execute?: boolean
  // canary shadow mode: accept and persist decisions but never call X mutators (INV-S25)
  blockExternalEffects?: boolean
  nowIso?: string
  headless?: boolean
  fypPosts?: readonly Readonly<{ id: string, author: string, text?: string }>[]
  /** Injected driver for tests; live runs build the Playwright driver inside execute. */
  driver?: EngagementDriver
  /** Read-only probes for pending reconciliation (defaults to driver verifiers). */
  reconcileDriver?: Pick<EngagementDriver, "verifyLiked" | "verifyFollowing">
}>): Promise<EngagementRunReport> {
  const config = loadConfig()
  const caps = engagementCapsFromConfig(config)
  const nowIso = args.nowIso ?? systemClock.nowIso()
  const state = new StateStore(join(args.agentRoot, "state"))
  const proposalPath = join(args.agentRoot, "reports", args.runId, "x-engagement.json")
  const fypBinding = resolveFypBinding(args)

  if (!existsSync(proposalPath) || !caps.enabled) {
    return {
      proposed: 0,
      accepted: 0,
      rejected: 0,
      executed: 0,
      verified: 0,
      ambiguous: 0,
      dryRun: Boolean(args.dryRun),
      blockedExternalEffects: Boolean(args.blockExternalEffects),
      fypEligiblePosts: fypBinding.count,
      decisions: [],
      receipts: [],
    }
  }

  let proposalRaw: unknown
  try {
    proposalRaw = JSON.parse(readFileSync(proposalPath, "utf8"))
  } catch {
    return {
      ...emptyReport(Boolean(args.dryRun), Boolean(args.blockExternalEffects), fypBinding.count),
      malformed: "json",
    }
  }

  let proposal
  try {
    proposal = parseEngagementProposal(proposalRaw)
  } catch {
    return {
      ...emptyReport(Boolean(args.dryRun), Boolean(args.blockExternalEffects), fypBinding.count),
      malformed: "schema",
    }
  }

  if (proposal.runId !== args.runId) {
    return {
      ...emptyReport(Boolean(args.dryRun), Boolean(args.blockExternalEffects), fypBinding.count),
      malformed: "run-id-mismatch",
    }
  }

  let current = state.loadXEngagement()
  let reconcileReceipts: readonly XEngagementReceipt[] = []
  let reconciled = 0

  const externalEffectsBlocked = args.blockExternalEffects === true
  const mayTouchBrowser = !args.dryRun && !externalEffectsBlocked && args.execute !== false

  let session: Awaited<ReturnType<typeof openPlaywrightEngagementSession>> | undefined
  let activeDriver = args.driver

  try {
    if (mayTouchBrowser && !activeDriver && current.pendingActionIds.length > 0) {
      session = await openPlaywrightEngagementSession({
        ...(args.headless === undefined ? {} : { headless: args.headless }),
      })
      activeDriver = session.driver
    }

    if (mayTouchBrowser && current.pendingActionIds.length > 0) {
      const reconcileDriver = args.reconcileDriver
        ?? (activeDriver
          ? {
            ...(activeDriver.verifyLiked ? { verifyLiked: activeDriver.verifyLiked } : {}),
            ...(activeDriver.verifyFollowing
              ? { verifyFollowing: activeDriver.verifyFollowing }
              : {}),
          }
          : undefined)

      if (reconcileDriver && (reconcileDriver.verifyLiked || reconcileDriver.verifyFollowing)) {
        const reconciledReport = await reconcilePendingEngagement({
          state: current,
          nowIso,
          runId: args.runId,
          driver: reconcileDriver,
        })
        if (
          reconciledReport.settled > 0
          || reconciledReport.clearedAbsent > 0
          || reconciledReport.receipts.length > 0
        ) {
          await state.saveXEngagement(reconciledReport.nextState)
          current = reconciledReport.nextState
          reconcileReceipts = reconciledReport.receipts
          reconciled = reconciledReport.settled + reconciledReport.clearedAbsent
        }
        if (reconciledReport.healthCleared) {
          await recordEngagementExecutionHealth({
            state,
            nowIso,
            runId: args.runId,
            receipts: reconciledReport.receipts.filter((r) => r.verified),
          })
        }
      }
    }

    const applied = applyEngagementChoices({
      proposal,
      state: current,
      caps,
      nowIso,
      fypPostIds: fypBinding.postIds,
      fypAuthors: fypBinding.authors,
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
        blockedExternalEffects: Boolean(args.blockExternalEffects),
        fypEligiblePosts: fypBinding.count,
        reconciled,
        decisions: applied.decisions,
        receipts: [...reconcileReceipts],
      }
    }

    let receipts: readonly XEngagementReceipt[] = [...reconcileReceipts]
    let verifiedActionIds: readonly `sha256:${string}`[] = []
    let ambiguousActionIds: readonly `sha256:${string}`[] = []
    let botHealthBlocked = false

    const healthAfterReconcile = state.loadXBotHealth(nowIso)
    const wouldMutate = !externalEffectsBlocked && args.execute !== false
    const escalated = xBotHealthEscalation(healthAfterReconcile).escalate

    if (escalated && wouldMutate) {
      // Stop mutations; do not persist new pending (would never auto-replay)
      botHealthBlocked = true
      archiveBotHealthBlocked({
        archiveRoot: args.archiveRoot,
        runId: args.runId,
        nowIso,
        consecutiveFailures: healthAfterReconcile.consecutiveFailures,
        ...(healthAfterReconcile.lastFailure?.error
          ? { lastError: healthAfterReconcile.lastFailure.error }
          : {}),
      })
      log.warn("x engagement blocked by bot health", {
        runId: args.runId,
        consecutiveFailures: healthAfterReconcile.consecutiveFailures,
      })
    } else {
      await state.saveXEngagement(applied.nextState)

      if (wouldMutate && applied.accepted.length > 0) {
        if (!activeDriver && !args.driver) {
          session = await openPlaywrightEngagementSession({
            ...(args.headless === undefined ? {} : { headless: args.headless }),
          })
          activeDriver = session.driver
        }
        const executed = await executeEngagementActions({
          accepted: applied.accepted,
          nowIso,
          ...(args.headless === undefined ? {} : { headless: args.headless }),
          ...(activeDriver ? { driver: activeDriver } : {}),
        })
        receipts = [...receipts, ...executed.receipts]
        verifiedActionIds = executed.verifiedActionIds
        ambiguousActionIds = executed.ambiguousActionIds

        const nextHealth = await recordEngagementExecutionHealth({
          state,
          nowIso,
          runId: args.runId,
          receipts: executed.receipts,
        })
        if (xBotHealthEscalation(nextHealth).escalate) {
          botHealthBlocked = true
          archiveBotHealthBlocked({
            archiveRoot: args.archiveRoot,
            runId: args.runId,
            nowIso,
            consecutiveFailures: nextHealth.consecutiveFailures,
            ...(nextHealth.lastFailure?.error
              ? { lastError: nextHealth.lastFailure.error }
              : {}),
          })
        }

        const after = state.loadXEngagement()
        const followed = new Set(after.followedHandles.map((h) => h.toLowerCase()))
        const liked = new Set(after.likedPostIds)
        const lastLikedAt = { ...after.lastLikedAt }
        const lastFollowedAt = { ...after.lastFollowedAt }
        const verifiedSet = new Set(verifiedActionIds)
        const failedSet = new Set(executed.failedActionIds)

        for (const decision of applied.accepted) {
          const id = decision.actionId as `sha256:${string}`
          if (!verifiedSet.has(id)) continue
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
          receipts: [...after.receipts, ...executed.receipts],
          pendingActionIds: after.pendingActionIds.filter((id) => (
            !verifiedSet.has(id as `sha256:${string}`)
            && !failedSet.has(id as `sha256:${string}`)
          )),
        }
        await state.saveXEngagement(next)
      }
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
      executed: receipts.length - reconcileReceipts.length,
      verified: verifiedActionIds.length,
      ambiguous: ambiguousActionIds.length,
      dryRun: false,
      blockedExternalEffects: externalEffectsBlocked,
      ...(botHealthBlocked ? { botHealthBlocked: true } : {}),
      fypEligiblePosts: fypBinding.count,
      reconciled,
      decisions: applied.decisions,
      receipts,
    }
  } finally {
    if (session) await session.close().catch(() => undefined)
  }
}

function emptyReport(
  dryRun: boolean,
  blockedExternalEffects: boolean,
  fypEligiblePosts: number,
): EngagementRunReport {
  return {
    proposed: 0,
    accepted: 0,
    rejected: 0,
    executed: 0,
    verified: 0,
    ambiguous: 0,
    dryRun,
    blockedExternalEffects,
    fypEligiblePosts,
    decisions: [],
    receipts: [],
  }
}

export function probeEngagementSummary(agentRoot: string, config: TrenchcoatConfig): unknown {
  const state = new StateStore(join(agentRoot, "state"))
  const file = state.loadXEngagement()
  const nowIso = systemClock.nowIso()
  const botHealth = state.loadXBotHealth(nowIso)
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
    botHealth,
    botHealthEscalation: xBotHealthEscalation(botHealth),
  }
}

export { recoverXBotHealth }

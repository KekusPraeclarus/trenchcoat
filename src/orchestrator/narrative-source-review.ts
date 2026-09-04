import { existsSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "../lib/config.js"
import { StateStore } from "../lib/state.js"
import { sha256Json } from "../lib/canonical-json.js"
import { twitterProfileDir } from "../collectors/social/twitter-auth.js"
import {
  executeEngagementActions,
  type EngagementDriver,
} from "../collectors/twitter/engagement.js"
import {
  backfillNarrativeProbation,
  markDemoted,
  markFollowed,
  reviewNarrativeSources,
  type NarrativeSourcesFile,
} from "../sources/narrative-lifecycle.js"
import { classifiedNarrativeXHandles } from "../sources/x-nominations.js"
import type { XEngagementDecision } from "../contracts/schemas.js"
import { loadActiveCanaryAssignment } from "../harness/canary.js"
import { log } from "../lib/log.js"

export type NarrativeSourceReviewReport = Readonly<{
  ok: boolean
  reason: string
  before: number
  after: NarrativeSourcesFile["sources"][number]["status"][]
  promoted: number
  demoted: number
  followed: number
  unfollowed: number
  followSkippedReason?: string
}>

function xSessionPresent(): boolean {
  return existsSync(join(twitterProfileDir(), "storage-state.json"))
}

function engagementDecision(args: Readonly<{
  action: "follow" | "unfollow"
  handle: string
  runId: string
  nowIso: string
}>): XEngagementDecision {
  return {
    schema: 1,
    actionId: sha256Json({
      action: args.action,
      handle: args.handle.toLowerCase(),
      runId: args.runId,
      reasonCode: "narrative-utility",
    }),
    action: args.action,
    target: args.handle.toLowerCase(),
    reasonCode: "narrative-utility",
    topics: [],
    accepted: true,
    runId: args.runId,
    decidedAt: args.nowIso,
  }
}

/** Host-only: apply narrative probation promotion/demotion rules and persist. */
export async function runNarrativeSourceReview(args: Readonly<{
  agentRoot: string
  nowIso: string
  runId?: string
  archiveRoot?: string
  dryRun?: boolean
  blockExternalEffects?: boolean
  engagementDriver?: EngagementDriver
}>): Promise<NarrativeSourceReviewReport> {
  const config = loadConfig()
  if (!config.fomo.enabled || !config.fomo.narrative_source_probation.enabled) {
    return {
      ok: false,
      reason: "fomo-disabled",
      before: 0,
      after: [],
      promoted: 0,
      demoted: 0,
      followed: 0,
      unfollowed: 0,
    }
  }

  const canary = args.archiveRoot
    ? loadActiveCanaryAssignment(args.archiveRoot, args.runId ?? "narrative-source-review")
    : undefined
  const blockExternal = args.blockExternalEffects === true
    || canary?.blockExternalEffects === true
  const dryRun = args.dryRun === true

  const state = new StateStore(join(args.agentRoot, "state"))
  const before = backfillNarrativeProbation(
    state.loadXNarrativeSources(),
    classifiedNarrativeXHandles(state.loadXSourceNominations()),
    args.nowIso,
    config.fomo.narrative_source_probation.probation_days,
  )
  const reviewed = reviewNarrativeSources(before, {
    nowIso: args.nowIso,
    minAccepted: config.fomo.narrative_source_probation.min_accepted_contributions,
    minDistinct: config.fomo.narrative_source_probation.min_distinct_narratives,
    demotionIdleDays: config.fomo.narrative_source_probation.demotion_idle_days,
  })

  const newlyEligible = reviewed.sources.filter((item) => {
    const prev = before.sources.find((row) => row.sourceId === item.sourceId)
    return prev?.status === "probation" && item.status === "follow-eligible"
  })
  const newlyDemotedFromFollowed = reviewed.sources.filter((item) => {
    const prev = before.sources.find((row) => row.sourceId === item.sourceId)
    return prev?.status === "followed" && item.status === "demoted"
  })

  // Hold followed→demoted until unfollow verifies; keep follow-eligible until follow verifies
  let next: NarrativeSourcesFile = {
    schema: 1,
    sources: reviewed.sources.map((item) => {
      const prev = before.sources.find((row) => row.sourceId === item.sourceId)
      if (prev?.status === "followed" && item.status === "demoted") {
        return { ...item, status: "followed" as const }
      }
      return item
    }),
  }

  let followed = 0
  let unfollowed = 0
  let followSkippedReason: string | undefined
  const runId = args.runId ?? "narrative-source-review"

  const canMutateX = !dryRun && !blockExternal
  if (!canMutateX) {
    followSkippedReason = dryRun ? "dry-run" : "block-external-effects"
  } else if (!xSessionPresent() && !args.engagementDriver) {
    followSkippedReason = "x-session-missing"
  } else {
    const decisions: XEngagementDecision[] = []
    const followTarget = newlyEligible[0]
    if (followTarget) {
      decisions.push(engagementDecision({
        action: "follow",
        handle: followTarget.handle,
        runId,
        nowIso: args.nowIso,
      }))
    }
    for (const item of newlyDemotedFromFollowed) {
      decisions.push(engagementDecision({
        action: "unfollow",
        handle: item.handle,
        runId,
        nowIso: args.nowIso,
      }))
    }

    if (decisions.length > 0) {
      try {
        const executed = await executeEngagementActions({
          accepted: decisions,
          nowIso: args.nowIso,
          ...(args.engagementDriver ? { driver: args.engagementDriver } : {}),
        })
        for (const receipt of executed.receipts) {
          if (!receipt.verified) continue
          if (receipt.action === "follow") {
            next = markFollowed(next, receipt.target, args.nowIso)
            followed += 1
          }
          if (receipt.action === "unfollow") {
            next = markDemoted(next, receipt.target, args.nowIso)
            unfollowed += 1
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : "engagement-failed"
        followSkippedReason = detail.includes("No X session") || detail.includes("session")
          ? "x-session-missing"
          : detail.slice(0, 120)
        log.warn("narrative source follow/unfollow skipped", { detail: followSkippedReason })
      }
    }
  }

  await state.saveXNarrativeSources(next)

  let promoted = 0
  let demoted = 0
  for (const item of next.sources) {
    const prev = before.sources.find((row) => row.sourceId === item.sourceId)
    if (!prev) continue
    if (prev.status === "probation" && (item.status === "follow-eligible" || item.status === "followed")) {
      promoted += 1
    }
    if (prev.status !== "demoted" && item.status === "demoted") demoted += 1
  }

  return {
    ok: true,
    reason: "reviewed",
    before: before.sources.length,
    after: next.sources.map((item) => item.status),
    promoted,
    demoted,
    followed,
    unfollowed,
    ...(followSkippedReason ? { followSkippedReason } : {}),
  }
}

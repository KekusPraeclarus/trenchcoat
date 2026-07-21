/**
 * Append-only supersession of invalidated market claims (INV-S28).
 * Never rewrites history; stops at attention-required when gates fail.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFileFsync } from "../lib/fs-atomic.js"
import { StateStore } from "../lib/state.js"
import {
  loadMarketClaimValidityIndex,
  saveMarketClaimValidityIndex,
  upsertClaimValidity,
  type MarketClaimRecord,
} from "../orchestrator/market-claims.js"
import {
  mergeNarrativeProposals,
  narrativeLogPath,
  narrativeProposalsPath,
  pruneNarrativeLogInMemory,
  type NarrativeLogEntry,
} from "../orchestrator/narrative-log.js"
import type { ClaimRevalidationResult } from "./schemas.js"

export type ReconcileReport = Readonly<{
  schema: 1
  incidentId: string
  reconciledAt: string
  narrativeSuperseded: number
  decisionsMarked: number
  alreadySuperseded: number
  attentionRequired: boolean
  attentionReason?: string
}>

function currentStage(
  agentRoot: string,
  slug: string,
): NarrativeLogEntry["stage"] | undefined {
  const path = narrativeLogPath(agentRoot)
  if (!existsSync(path)) return undefined
  const { entries } = pruneNarrativeLogInMemory(
    readFileSync(path, "utf8"),
    new Date().toISOString(),
    3650,
  )
  return entries.find((e) => e.slug === slug)?.stage
}

/**
 * For invalidated narrative-fade/stage claims that current state still reflects,
 * append a corrective narrative proposal and merge via the normal host path.
 */
export async function reconcileInvalidatedClaims(args: Readonly<{
  agentRoot: string
  incidentId: string
  nowIso: string
  claims: readonly MarketClaimRecord[]
  results: readonly ClaimRevalidationResult[]
}>): Promise<ReconcileReport> {
  const invalidatedIds = new Set(
    args.results.filter((r) => r.verdict === "invalidated").map((r) => r.claimId),
  )
  let validity = loadMarketClaimValidityIndex(args.agentRoot)
  let narrativeSuperseded = 0
  let decisionsMarked = 0
  let alreadySuperseded = 0
  let attentionRequired = false
  let attentionReason: string | undefined

  const narrativeFixes: NarrativeLogEntry[] = []

  for (const claim of args.claims) {
    if (!invalidatedIds.has(claim.claimId)) continue

    const existing = validity.entries.find((e) => e.claimId === claim.claimId)
    if (
      existing?.validity === "invalidated"
      || existing?.validity === "already-superseded"
    ) {
      alreadySuperseded += 1
      continue
    }

    if (claim.kind === "narrative-stage" || claim.auditClaimType === "narrative-fade") {
      const stage = currentStage(args.agentRoot, claim.subject)
      if (claim.narrativeStage === "fading" || claim.auditClaimType === "narrative-fade") {
        if (stage === "fading") {
          // State already matches the (now-invalid) fade — restore toward peaking
          // only when evidence in revalidation cited peaking. Default: mark peaking
          // as the corrective stage when fade was wrong.
          narrativeFixes.push({
            slug: claim.subject,
            title: claim.summary.slice(0, 128) || claim.subject,
            firstSeen: claim.occurredAt,
            lastSeen: args.nowIso,
            evidence: [
              `remediation:${args.incidentId}:fade-invalidated`,
            ],
            stage: "peaking",
          })
        } else if (stage === "peaking" || stage === "emerging") {
          alreadySuperseded += 1
          validity = upsertClaimValidity(validity, {
            schema: 1,
            claimId: claim.claimId,
            validity: "already-superseded",
            incidentId: args.incidentId,
            reason: "state-already-non-fading",
            updatedAt: args.nowIso,
          })
          continue
        }
      }
    }

    if (claim.kind === "decision") {
      // Decision supersession requires a full DecisionCard through applyDecisionProposals.
      // Mark validity here; host correction path may attach a superseding proposal later.
      validity = upsertClaimValidity(validity, {
        schema: 1,
        claimId: claim.claimId,
        validity: "invalidated",
        incidentId: args.incidentId,
        reason: "decision-invalidated-pending-operator-or-followup",
        updatedAt: args.nowIso,
      })
      decisionsMarked += 1
      continue
    }

    if (claim.kind === "broadcast") {
      validity = upsertClaimValidity(validity, {
        schema: 1,
        claimId: claim.claimId,
        validity: "invalidated",
        incidentId: args.incidentId,
        reason: "broadcast-invalidated",
        updatedAt: args.nowIso,
      })
    }
  }

  if (narrativeFixes.length > 0) {
    const proposalPath = narrativeProposalsPath(args.agentRoot, `remediation-${args.incidentId}`)
    const body = `${narrativeFixes.map((e) => JSON.stringify(e)).join("\n")}\n`
    await writeAtomicFileFsync(proposalPath, body)
    try {
      await mergeNarrativeProposals({
        agentRoot: args.agentRoot,
        runId: `remediation-${args.incidentId}`,
        nowIso: args.nowIso,
      })
      narrativeSuperseded = narrativeFixes.length
      for (const claim of args.claims) {
        if (!invalidatedIds.has(claim.claimId)) continue
        if (claim.kind !== "narrative-stage" && claim.auditClaimType !== "narrative-fade") {
          continue
        }
        validity = upsertClaimValidity(validity, {
          schema: 1,
          claimId: claim.claimId,
          validity: "invalidated",
          incidentId: args.incidentId,
          supersededBy: `remediation-${args.incidentId}`,
          reason: "narrative-stage-superseded",
          updatedAt: args.nowIso,
        })
      }
    } catch (error) {
      attentionRequired = true
      attentionReason = error instanceof Error
        ? error.message.slice(0, 280)
        : "narrative-merge-failed"
    }
  }

  await saveMarketClaimValidityIndex(args.agentRoot, validity)

  // Touch state store so INDEX consumers see activity without rewriting history
  try {
    const state = new StateStore(join(args.agentRoot, "state"))
    void state
  } catch {
    // ignore
  }

  return {
    schema: 1,
    incidentId: args.incidentId,
    reconciledAt: args.nowIso,
    narrativeSuperseded,
    decisionsMarked,
    alreadySuperseded,
    attentionRequired,
    ...(attentionReason ? { attentionReason } : {}),
  }
}

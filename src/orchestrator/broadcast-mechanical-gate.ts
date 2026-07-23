/**
 * Host mechanical pre-gate before broadcast worthiness LLM (token-burn).
 * Fail-closed duplicates / instruction spam; founder-urgent narrative pass-through.
 */

import type { BroadcastItem } from "../contracts/schemas.js"
import { isInstructionShapedText } from "./alpha.js"
import { claimHash } from "./broadcast-worthiness.js"
import {
  DEVELOPMENT_REPEAT_WINDOW_HOURS,
  developmentSalientTokens,
} from "./narrative-development.js"
import type { MarketClaimRecord } from "./market-claims.js"

export type MechanicalBroadcastGateContext = Readonly<{
  proposedSubjectsSeen: Set<string>
  proposedClaimHashes: Set<string>
  recentAcceptedClaims: readonly MarketClaimRecord[]
  nowIso: string
}>

/** Urgent narrative emergence/development — never mechanically reject (ADR 024 pass-through). */
export function isFounderPrimaryPassThrough(item: BroadcastItem): boolean {
  if (item.severity !== "urgent") return false
  const rule = item.auditClaim.verificationRule
  return rule === "narrative.emergence" || rule === "narrative.development"
}

function withinWindow(occurredAt: string, nowIso: string, hours: number): boolean {
  const at = Date.parse(occurredAt)
  const now = Date.parse(nowIso)
  if (!Number.isFinite(at) || !Number.isFinite(now)) return false
  return now - at <= hours * 3_600_000 && at <= now
}

/** True when item.text has no novel salient stems vs 48h same-subject accepted claims. */
function isMechanicalRepeatBroadcast(
  item: BroadcastItem,
  recentAcceptedClaims: readonly MarketClaimRecord[],
  nowIso: string,
): boolean {
  const subject = item.auditClaim.subject.trim().toLowerCase()
  const seen = new Set<string>()
  let anyPrior = false
  for (const prior of recentAcceptedClaims) {
    if (prior.subject.trim().toLowerCase() !== subject) continue
    if (!withinWindow(prior.occurredAt, nowIso, DEVELOPMENT_REPEAT_WINDOW_HOURS)) continue
    anyPrior = true
    for (const token of developmentSalientTokens(prior.summary)) {
      seen.add(token.slice(0, 4))
    }
  }
  if (!anyPrior) return false
  const fresh = [...developmentSalientTokens(item.text)]
    .filter((token) => !seen.has(token.slice(0, 4)))
  return fresh.length === 0
}

/**
 * Evaluate mechanical broadcast rejects. Mutates proposedSubjectsSeen /
 * proposedClaimHashes when this item is the first occurrence of that key.
 */
export function evaluateMechanicalBroadcastGate(
  item: BroadcastItem,
  ctx: MechanicalBroadcastGateContext,
): { ok: true } | { ok: false; reason: string } {
  const subject = item.auditClaim.subject.trim().toLowerCase()
  const hash = claimHash(item.auditClaim)

  if (isFounderPrimaryPassThrough(item)) {
    ctx.proposedSubjectsSeen.add(subject)
    ctx.proposedClaimHashes.add(hash)
    return { ok: true }
  }

  if (ctx.proposedSubjectsSeen.has(subject)) {
    return { ok: false, reason: "duplicate-subject-in-run" }
  }
  if (ctx.proposedClaimHashes.has(hash)) {
    return { ok: false, reason: "duplicate-claim-in-run" }
  }

  ctx.proposedSubjectsSeen.add(subject)
  ctx.proposedClaimHashes.add(hash)

  if (isMechanicalRepeatBroadcast(item, ctx.recentAcceptedClaims, ctx.nowIso)) {
    return { ok: false, reason: "mechanical-repeat-broadcast" }
  }
  if (isInstructionShapedText(item.text)) {
    return { ok: false, reason: "instruction-shaped-proposal" }
  }
  return { ok: true }
}

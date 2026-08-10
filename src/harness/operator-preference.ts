import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  OperatorPreferenceSetSchema,
  type DecisionPolicyDocument,
  type OperatorPreferenceSet,
} from "../contracts/schemas.js"
import { interpretPolicy } from "./policy.js"

/**
 * Harness-side view of operator preferences (ADR 043). The harness reads one
 * sealed numeric file and nothing else — it never imports the live feedback
 * store, the ledger, or any operator text (INV-S24).
 */

export const ACTIVE_PREFERENCE_SET_FILE = "active-preference-set.json"

export function activePreferenceSetPath(
  home = join(homedir(), ".trenchcoat"),
): string {
  return join(home, "broadcast-feedback", "sealed", ACTIVE_PREFERENCE_SET_FILE)
}

/** Missing or unreadable file means no preference constraint */
export function loadActivePreferenceSet(
  path = activePreferenceSetPath(),
): OperatorPreferenceSet | undefined {
  if (!existsSync(path)) return undefined
  try {
    return OperatorPreferenceSetSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return undefined
  }
}

export type PreferenceAgreement = Readonly<{
  pairs: number
  agreed: number
  /** Share of pairs where the policy scores the preferred item at least as high */
  agreement: number
}>

/**
 * Share of preference pairs the policy respects. A pair agrees when the policy
 * score for the preferred broadcast is at least the rejected one.
 */
export function preferenceAgreement(args: Readonly<{
  policy: DecisionPolicyDocument
  set: OperatorPreferenceSet
}>): PreferenceAgreement {
  let agreed = 0
  for (const pair of args.set.pairs) {
    const preferred = interpretPolicy(args.policy, {
      subjectId: `${pair.pairId}:preferred`,
      signals: pair.preferredSignals,
    })
    const rejected = interpretPolicy(args.policy, {
      subjectId: `${pair.pairId}:rejected`,
      signals: pair.rejectedSignals,
    })
    if (preferred.score >= rejected.score) agreed += 1
  }
  const pairs = args.set.pairs.length
  return { pairs, agreed, agreement: pairs === 0 ? 1 : agreed / pairs }
}

export type PreferenceRegression = Readonly<{
  ok: boolean
  baseline: number
  candidate: number
  reason?: string
}>

/**
 * Reject a later harness candidate that reduces agreement with the active
 * sealed preference set. An absent set never blocks a candidate.
 */
export function checkPreferenceRegression(args: Readonly<{
  baselinePolicy: DecisionPolicyDocument
  candidatePolicy: DecisionPolicyDocument
  set?: OperatorPreferenceSet
}>): PreferenceRegression {
  if (!args.set || args.set.pairs.length === 0) {
    return { ok: true, baseline: 1, candidate: 1 }
  }
  const baseline = preferenceAgreement({ policy: args.baselinePolicy, set: args.set })
  const candidate = preferenceAgreement({ policy: args.candidatePolicy, set: args.set })
  if (candidate.agreement < baseline.agreement) {
    return {
      ok: false,
      baseline: baseline.agreement,
      candidate: candidate.agreement,
      reason: "operator-preference-regression",
    }
  }
  return { ok: true, baseline: baseline.agreement, candidate: candidate.agreement }
}

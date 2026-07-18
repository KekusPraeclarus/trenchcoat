import { readFileSync } from "node:fs"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import {
  DecisionPolicyDocumentSchema,
  type DecisionPolicyDocument,
} from "../contracts/schemas.js"

export type PolicyEvidence = Readonly<{
  subjectId: string
  signals: Readonly<Record<string, number>>
}>

export type PolicyVerdict = Readonly<{
  verdict: "track" | "drop" | "ignore" | "revisit"
  confidence: number
  score: number
  firedRuleId?: string
}>

// Banding defaults when a policy omits an explicit threshold, chosen so an
// empty policy degrades to ignore rather than silently tracking everything
const DEFAULT_TRACK_AT = 0.5
const DEFAULT_IGNORE_AT = 0
const DEFAULT_DROP_AT = -0.5

export function loadPolicy(path: string): DecisionPolicyDocument {
  return DecisionPolicyDocumentSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

export async function savePolicy(
  path: string,
  doc: DecisionPolicyDocument,
): Promise<void> {
  const parsed = DecisionPolicyDocumentSchema.parse(doc)
  await writeAtomicFile(path, `${JSON.stringify(parsed, null, 2)}\n`)
}

// Map an unbounded score onto a 0..100 confidence with a linear, auditable
// squash, no logistic so the mapping stays inspectable by a human reviewer
function scoreToConfidence(score: number): number {
  const shifted = 50 + score * 50
  return Math.round(Math.max(0, Math.min(100, shifted)))
}

/**
 * Deterministic verdict from a policy document and a single subject's signals.
 *
 * Order of evaluation is fixed and side-effect free:
 *   1 weighted sum of shared signal keys (sorted for order independence)
 *   2 rules fire in document order, first match wins and overrides banding
 *   3 otherwise the score falls into a track/ignore/drop/revisit band
 *
 * rule.when is treated as a literal signal key, never an expression, so a
 * candidate policy authored inside the harness cannot smuggle in evaluation
 * of arbitrary text
 */
export function interpretPolicy(
  doc: DecisionPolicyDocument,
  evidence: PolicyEvidence,
): PolicyVerdict {
  let score = 0
  for (const [key, weight] of Object.entries(doc.weights).sort(([a], [b]) => a.localeCompare(b))) {
    score += weight * (evidence.signals[key] ?? 0)
  }

  const confidence = scoreToConfidence(score)

  for (const rule of doc.rules) {
    const signal = evidence.signals[rule.when]
    if (signal !== undefined && signal > 0) {
      return { verdict: rule.then, confidence, score, firedRuleId: rule.id }
    }
  }

  const trackAt = doc.thresholds["track"] ?? DEFAULT_TRACK_AT
  const ignoreAt = doc.thresholds["ignore"] ?? DEFAULT_IGNORE_AT
  const dropAt = doc.thresholds["drop"] ?? DEFAULT_DROP_AT

  if (score >= trackAt) return { verdict: "track", confidence, score }
  if (score <= dropAt) return { verdict: "drop", confidence, score }
  if (score <= ignoreAt) return { verdict: "ignore", confidence, score }
  return { verdict: "revisit", confidence, score }
}

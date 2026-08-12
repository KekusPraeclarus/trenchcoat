import type { ReviewDecision } from "./schemas.js"

export type PreReviewLoopDecision =
  | { kind: "approve" }
  | { kind: "revise"; nextCount: number }
  | { kind: "fail"; reason: string }

/**
 * Host policy for pre-review outcomes.
 * revise may re-enter propose with priorPreReviewPath up to maxRevises times.
 * reject and revise-exhausted fail closed for operator attention.
 */
export function decidePreReviewLoop(args: Readonly<{
  decision: ReviewDecision
  reviseCount: number
  maxRevises: number
}>): PreReviewLoopDecision {
  if (args.decision === "approve") return { kind: "approve" }
  if (args.decision === "reject") {
    return { kind: "fail", reason: "pre-review-reject" }
  }
  const nextCount = args.reviseCount + 1
  if (nextCount > args.maxRevises) {
    return {
      kind: "fail",
      reason: `pre-review-revise-exhausted:${args.maxRevises}`,
    }
  }
  return { kind: "revise", nextCount }
}

/**
 * Shared host validation for research track/subscribe decisions.
 * Used by operator research proposals and Discord watch subscription.
 */

import { loadDecisionProposals } from "./proposals.js"
import { mintTrackBlockReason } from "../collectors/market/security.js"
import type { CanonicalIdentity, DecisionProposal, Verdict } from "../contracts/schemas.js"

export type SecuritySnapshot = Readonly<{
  status: string
  hardFail: boolean
  flags: readonly string[]
}>

export type ResearchSubscribeDecision = Readonly<{
  subscribe: boolean
  verdict?: Verdict
  reason?: string
  proposal?: DecisionProposal
}>

function identityMatches(
  proposal: DecisionProposal,
  identity: CanonicalIdentity,
): boolean {
  const id = proposal.card.identity
  if (!id) return false
  return id.chain === identity.chain
    && id.tokenAddress.toLowerCase() === identity.tokenAddress.toLowerCase()
}

/**
 * Fail-closed subscribe gate: requires a schema-valid track proposal for the
 * resolved identity, a non-hard-fail scanner status, and the contextual mint rule.
 */
export function evaluateResearchSubscribe(args: Readonly<{
  agentRoot: string
  runId: string
  identity: CanonicalIdentity
  security: SecuritySnapshot
}>): ResearchSubscribeDecision {
  if (args.security.hardFail || args.security.status === "hard-fail") {
    return { subscribe: false, reason: "security-hard-fail" }
  }
  if (args.security.status === "pending" || args.security.status === "unsupported-chain") {
    return { subscribe: false, reason: `security-${args.security.status}` }
  }

  const file = loadDecisionProposals(args.agentRoot, args.runId)
  if (!file) {
    return { subscribe: false, reason: "verdict-missing" }
  }

  const matching = file.proposals.filter((p) => identityMatches(p, args.identity))
  if (matching.length === 0) {
    return { subscribe: false, reason: "verdict-identity-mismatch" }
  }

  const track = matching.find((p) => p.card.verdict === "track")
  if (!track) {
    const first = matching[0]!
    return {
      subscribe: false,
      verdict: first.card.verdict,
      reason: `verdict-${first.card.verdict}`,
      proposal: first,
    }
  }

  const mintBlock = mintTrackBlockReason(
    args.security.flags,
    track.card.projectClassification,
  )
  if (mintBlock) {
    return {
      subscribe: false,
      verdict: "track",
      reason: mintBlock,
      proposal: track,
    }
  }

  return { subscribe: true, verdict: "track", proposal: track }
}

/**
 * Shared host validation for research track / Discord watch decisions.
 * Discord member-watch is permissive; main-agent track stays fail-closed.
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
 * Discord watchlist gate: every completed research token is watched for member
 * updates unless the scanner hard-failed.
 */
export function evaluateDiscordWatchSubscribe(
  security: SecuritySnapshot,
): ResearchSubscribeDecision {
  if (security.hardFail || security.status === "hard-fail") {
    return { subscribe: false, reason: "security-hard-fail" }
  }
  return { subscribe: true }
}

/**
 * Main-agent track gate: requires a schema-valid track proposal for the
 * resolved identity, a non-hard-fail scanner status, and the contextual mint rule.
 */
export function evaluateResearchSubscribe(args: Readonly<{
  agentRoot: string
  runId: string
  identity: CanonicalIdentity
  security: SecuritySnapshot
  marketQuality?: { status: "pass" | "fail" }
}>): ResearchSubscribeDecision {
  if (args.security.hardFail || args.security.status === "hard-fail") {
    return { subscribe: false, reason: "security-hard-fail" }
  }
  if (args.security.status === "pending" || args.security.status === "unsupported-chain") {
    return { subscribe: false, reason: `security-${args.security.status}` }
  }
  if (args.marketQuality?.status === "fail") {
    return { subscribe: false, reason: "market-quality-fail" }
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

  if (track.watchlistStatus === "watching") {
    return {
      subscribe: false,
      verdict: "track",
      reason: "watchlist-status-watching",
      proposal: track,
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

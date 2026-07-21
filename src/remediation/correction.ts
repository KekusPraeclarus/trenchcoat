/**
 * Destination-aware finding.correction builders and copy helpers (INV-S28).
 */

import { createHash } from "node:crypto"
import type { MarketClaimRecord } from "../orchestrator/market-claims.js"
import {
  CORRECTION_DISCORD_PROMPT,
  CORRECTION_TELEGRAM_PROMPT,
} from "../prompts/host.js"
import type { ClaimRevalidationResult } from "./schemas.js"

export { CORRECTION_DISCORD_PROMPT, CORRECTION_TELEGRAM_PROMPT }
export type CorrectionChannelPayloads = Readonly<{
  telegram: { text: string }
  discord: { text: string }
}>

export function correctionEventId(args: Readonly<{
  incidentId: string
  destination: "telegram" | "discord"
  claimIds: readonly string[]
}>): `sha256:${string}` {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      type: "finding.correction",
      incidentId: args.incidentId,
      destination: args.destination,
      claimIds: [...args.claimIds].sort(),
    }))
    .digest("hex")
  return `sha256:${digest}`
}

/**
 * Destination-scoped invalidated *public* broadcasts for correction egress.
 * Narrative/decision claims never produce a public correction on their own —
 * only finding.broadcast claims that actually went to that destination.
 */
export function claimsForDestination(args: Readonly<{
  claims: readonly MarketClaimRecord[]
  invalidatedIds: ReadonlySet<string>
  destination: "telegram" | "discord"
}>): MarketClaimRecord[] {
  return args.claims.filter((c) =>
    c.kind === "broadcast"
    && args.invalidatedIds.has(c.claimId)
    && c.destinations.includes(args.destination),
  )
}

/** Host-rendered fallback copy when distill session unavailable. */
export function renderCorrectionFallback(args: Readonly<{
  claims: readonly MarketClaimRecord[]
  results: readonly ClaimRevalidationResult[]
  recoveredSource: string
  destination: "telegram" | "discord"
}>): string {
  const invalidated = new Set(
    args.results.filter((r) => r.verdict === "invalidated").map((r) => r.claimId),
  )
  const lines = args.claims
    .filter((c) => invalidated.has(c.claimId))
    .map((c) => {
      const reason = args.results.find((r) => r.claimId === c.claimId)?.reason
      return `- ${c.subject}: ${reason ?? "no longer stands"}`
    })

  if (args.destination === "discord") {
    const subjects = args.claims
      .filter((c) => invalidated.has(c.claimId))
      .map((c) => c.subject)
      .slice(0, 8)
    return [
      `Update: prior call(s) on ${subjects.join(", ")} no longer stand after post-fix data.`,
      `${args.recoveredSource} recovered. Treat as early warning / retract, not confirmed.`,
    ].join(" ").slice(0, 500)
  }

  return [
    "Update on prior calls. Post-fix data means some claims no longer stand.",
    "",
    "**Invalidated**",
    ...lines.slice(0, 12),
    "",
    `**Recovery**`,
    `${args.recoveredSource} is healthy again after the fix.`,
    "",
    "**Bottom line**",
    "Treat invalidated calls as early/partial warnings, not clean confirmations.",
  ].join("\n")
}

export function buildCorrectionPayloads(args: Readonly<{
  telegramClaims: readonly MarketClaimRecord[]
  discordClaims: readonly MarketClaimRecord[]
  results: readonly ClaimRevalidationResult[]
  recoveredSource: string
  telegramText?: string
  discordText?: string
}>): CorrectionChannelPayloads {
  return {
    telegram: {
      text: (args.telegramText
        ?? renderCorrectionFallback({
          claims: args.telegramClaims,
          results: args.results,
          recoveredSource: args.recoveredSource,
          destination: "telegram",
        })).slice(0, 64_000),
    },
    discord: {
      text: (args.discordText
        ?? renderCorrectionFallback({
          claims: args.discordClaims,
          results: args.results,
          recoveredSource: args.recoveredSource,
          destination: "discord",
        })).slice(0, 1_000),
    },
  }
}

export function singleDiscordReplyTarget(args: Readonly<{
  claims: readonly MarketClaimRecord[]
  providerMessageIds?: Readonly<Record<string, string>>
}>): string | undefined {
  if (args.claims.length !== 1) return undefined
  const eventId = args.claims[0]?.eventId
  if (!eventId || !args.providerMessageIds) return undefined
  return args.providerMessageIds[eventId]
}

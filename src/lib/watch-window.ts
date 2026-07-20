/**
 * Host-owned watch prose for channel copy. Decoupled from AuditClaim.horizonHours
 * (settlement math stays 24/72/168). Never agent-authored.
 */

import type { AuditClaim, BroadcastClaimType } from "../contracts/schemas.js"

export const WATCH_WINDOWS = [
  "today",
  "the next day",
  "the next few days",
  "this week",
  "the coming weeks",
  "this month",
  "through next month",
] as const

export type WatchWindow = (typeof WATCH_WINDOWS)[number]

const NARRATIVE_LIKE = new Set<BroadcastClaimType>([
  "narrative-emergence",
  "narrative-fade",
  "rotation",
])

/** Default scrub target when only an hour token is known (no claim type). */
export function watchWindowForHours(hours: number): WatchWindow {
  if (hours <= 24) return "the next day"
  if (hours <= 72) return "the next few days"
  return "this week"
}

/**
 * Communicative watch window from claim type + settlement horizon.
 * Narrative/rotation sit one bucket longer than raw hours (stickier heat).
 */
export function deriveWatchWindow(
  claim: Readonly<{ type: BroadcastClaimType; horizonHours: number }>,
): WatchWindow {
  const hours = claim.horizonHours
  const narrative = NARRATIVE_LIKE.has(claim.type)

  if (hours <= 24) {
    return narrative ? "the next few days" : hours <= 12 ? "today" : "the next day"
  }
  if (hours <= 72) {
    return narrative ? "this week" : "the next few days"
  }
  // 73–168
  if (narrative) {
    return hours >= 120 ? "through next month" : "this month"
  }
  return hours >= 120 ? "the coming weeks" : "this week"
}

const HOUR_TOKEN = String.raw`(24|72|168)\s*h(?:ours?|rs?)?`
/** Phrase wrappers + bare tokens; natural prose (this week, this month) left alone */
const LEAKED_HOUR = new RegExp(
  String.raw`\b(?:(?:over|in|within|for)\s+(?:the\s+)?next\s+|next\s+)?${HOUR_TOKEN}\b`,
  "giu",
)

function hoursFromMatch(match: string): number {
  const m = /(\d+)/u.exec(match)
  return m ? Number(m[1]) : 72
}

/**
 * Thin scrub: replace leaked 24h|72h|168h (and common wrappers) only.
 * Does not rewrite already-natural phrases.
 */
export function scrubLeakedHourHorizons(text: string): string {
  return text.replace(LEAKED_HOUR, (match) => watchWindowForHours(hoursFromMatch(match)))
}

/** claimLine fragment for distill prompts */
export function watchWindowClaimFragment(claim: AuditClaim): string {
  return `watchWindow=${deriveWatchWindow(claim)}`
}

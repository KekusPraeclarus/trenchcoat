/**
 * Host-owned watch prose for channel copy. Decoupled from AuditClaim.horizonHours
 * (settlement math stays 24/72/168). Never agent-authored.
 *
 * Weekly timeframes are banned from watch copy: week-scale buckets derive the
 * conditional "if it holds" and outbound text scrubs weekly phrases to it.
 */

import type { AuditClaim } from "../contracts/schemas.js"

export const WATCH_WINDOWS = [
  "today",
  "the next day",
  "the next few days",
  "if it holds",
  "this month",
  "through next month",
] as const

export type WatchWindow = (typeof WATCH_WINDOWS)[number]

type ClaimType = AuditClaim["type"]

const NARRATIVE_LIKE = new Set<ClaimType>([
  "narrative-emergence",
  "narrative-fade",
  "narrative-development",
  "rotation",
])

/** Default scrub target when only an hour token is known (no claim type). */
export function watchWindowForHours(hours: number): WatchWindow {
  if (hours <= 24) return "the next day"
  if (hours <= 72) return "the next few days"
  return "this month"
}

/**
 * Communicative watch window from claim type + settlement horizon.
 * Narrative/rotation sit one bucket longer than raw hours (stickier heat).
 * Week-scale buckets return the conditional "if it holds" — weekly timeframes
 * never reach channel copy.
 */
export function deriveWatchWindow(
  claim: Readonly<{ type: ClaimType; horizonHours: number }>,
): WatchWindow {
  const hours = claim.horizonHours
  const narrative = NARRATIVE_LIKE.has(claim.type)

  if (hours <= 24) {
    return narrative ? "the next few days" : hours <= 12 ? "today" : "the next day"
  }
  if (hours <= 72) {
    return narrative ? "if it holds" : "the next few days"
  }
  // 73–168
  if (narrative) {
    return hours >= 120 ? "through next month" : "this month"
  }
  return hours >= 120 ? "this month" : "if it holds"
}

const HOUR_TOKEN = String.raw`(24|72|168)\s*h(?:ours?|rs?)?`
/** Phrase wrappers + bare tokens; natural prose (this month, next month) left alone */
const LEAKED_HOUR = new RegExp(
  String.raw`\b(?:(?:over|in|within|for)\s+(?:the\s+)?next\s+|next\s+)?${HOUR_TOKEN}\b`,
  "giu",
)

/**
 * Weekly timeframe crutch ("this week", "over the coming weeks", "next week's").
 * Banned from watch prose — rewrite to the same conditional the distill prompts
 * are told to use for week-scale claims.
 */
const WEEKLY_TIMEFRAME = new RegExp(
  String.raw`\b(?:(?:over|in|within|for|through|into|during|later)\s+)?(?:(?:the\s+)?(?:coming|next)\s+|(?:this|the)\s+)weeks?'?s?\b`,
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

/** Rewrite weekly timeframe phrases to the conditional "if it holds". */
export function scrubWeeklyTimeframes(text: string): string {
  return text.replace(WEEKLY_TIMEFRAME, "if it holds")
}

/** Full outbound watch-prose scrub: leaked hour tokens, then weekly timeframes. */
export function scrubWatchProse(text: string): string {
  return scrubWeeklyTimeframes(scrubLeakedHourHorizons(text))
}

/** claimLine fragment for distill prompts */
export function watchWindowClaimFragment(claim: AuditClaim): string {
  return `watchWindow=${deriveWatchWindow(claim)}`
}

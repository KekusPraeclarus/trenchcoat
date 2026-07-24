/**
 * Host helpers: suppress status-quo narrative heat restatements in broadcasts.
 * Mention a known narrative's stage only when heat changes (emerging/peaking/fading).
 */

import type { BroadcastItem } from "../contracts/schemas.js"
import {
  narrativeAliases,
  textMentionsNarrativeAlias,
} from "../lib/narrative-aliases.js"
import {
  effectiveFraming,
  type NarrativeFraming,
} from "../lib/narrative-framing.js"
import type { NarrativeLogEntry } from "./narrative-log.js"

const NARRATIVE_CLAIM_TYPES = new Set([
  "narrative-emergence",
  "narrative-fade",
  "rotation",
])

const STATUS_QUO_FILLER =
  /\b(?:still have|continues to|under that|still peaking|still at peak|remains peaking|continues peaking|already peaking|already at peak|still fading|still emerging)\b|\bremains\b/iu

export type NarrativeStage = NarrativeLogEntry["stage"]

export type StageKnown = Readonly<{
  slug: string
  title: string
  stage: NarrativeStage
  framing?: NarrativeFraming | undefined
}>

export { narrativeAliases }

/** Narratives whose stage did not change this run (status-quo heat). */
export function statusQuoNarratives(
  logBefore: readonly NarrativeLogEntry[],
  logAfter?: readonly NarrativeLogEntry[],
): StageKnown[] {
  const afterBySlug = logAfter
    ? new Map(logAfter.map((entry) => [entry.slug, entry]))
    : undefined
  const out: StageKnown[] = []
  for (const prior of logBefore) {
    const after = afterBySlug?.get(prior.slug)
    if (after && after.stage !== prior.stage) continue
    const survivor = after ?? prior
    out.push({
      slug: survivor.slug,
      title: survivor.title,
      stage: survivor.stage,
      framing: effectiveFraming(survivor),
    })
  }
  return out
}

function stageMentionPattern(stage: NarrativeStage): RegExp {
  switch (stage) {
    case "peaking":
      return /\b(?:peaking|at peak|peak(?:ing)?)\b/iu
    case "emerging":
      return /\bemerging\b/iu
    case "fading":
      return /\b(?:fading|faded)\b/iu
  }
}

/**
 * True when text restates a status-quo narrative at its known stage
 * (e.g. "rh rotation still peaking" while rh-chain-meme-rotation is already peaking).
 */
export function restatesUnchangedNarrativeStage(
  text: string,
  statusQuo: readonly StageKnown[],
): boolean {
  for (const entry of statusQuo) {
    if (!textMentionsNarrativeAlias(text, entry)) continue
    if (stageMentionPattern(entry.stage).test(text)) return true
    // Filler phrases only count when the same sentence names this narrative
    if (STATUS_QUO_FILLER.test(text)) return true
  }
  return false
}

/**
 * Gate narrative audit claims: allow new slugs and stage transitions only.
 * Re-sightings at the same heat are rejected.
 */
export function assertNarrativeBroadcastAllowed(args: Readonly<{
  item: BroadcastItem
  logBefore: readonly NarrativeLogEntry[]
  logAfter?: readonly NarrativeLogEntry[]
}>): { ok: true; sameStageDevelopment?: true } | { ok: false; reason: string } {
  const claim = args.item.auditClaim
  if (!NARRATIVE_CLAIM_TYPES.has(claim.type)) return { ok: true }

  const subject = claim.subject.trim().toLowerCase()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(subject)) return { ok: true }

  const prior = args.logBefore.find((entry) => entry.slug === subject)
  if (!prior) return { ok: true }

  const after = args.logAfter?.find((entry) => entry.slug === subject)
  if (after && after.stage !== prior.stage) return { ok: true }

  // Fade claim may announce a transition even if merge already wrote fading
  if (claim.type === "narrative-fade" && prior.stage !== "fading") {
    return { ok: true }
  }

  // Emergence/rotation into peaking from emerging counts as heat increase
  if (
    (claim.type === "narrative-emergence" || claim.type === "rotation")
    && prior.stage === "emerging"
    && after?.stage === "peaking"
  ) {
    return { ok: true }
  }

  if (claim.type === "narrative-emergence" || claim.type === "rotation") {
    return { ok: true, sameStageDevelopment: true }
  }

  return { ok: false, reason: "narrative-unchanged-stage" }
}

export function statusQuoFillerPattern(): RegExp {
  return STATUS_QUO_FILLER
}

/**
 * Host helpers: suppress status-quo narrative heat restatements in broadcasts.
 * Mention a known narrative's stage only when heat changes (emerging/peaking/fading).
 */

import type { BroadcastItem } from "../contracts/schemas.js"
import type { NarrativeLogEntry } from "./narrative-log.js"

const NARRATIVE_CLAIM_TYPES = new Set([
  "narrative-emergence",
  "narrative-fade",
  "rotation",
])

const STAGE_STOPWORDS = new Set([
  "meme",
  "meta",
  "sol",
  "the",
  "and",
  "for",
  "surge",
  "collapse",
  "trust",
  "bridge",
  "agents",
  "fun",
  "coin",
  "chain",
  "base",
  "token",
  "launch",
])

/** Short tokens allowed as distinctive aliases (operator shorthand). */
const SHORT_ALIAS_ALLOW = new Set(["rh", "pfp"])

const STATUS_QUO_FILLER =
  /\b(?:still have|continues to|under that|still peaking|still at peak|remains peaking|continues peaking|already peaking|already at peak|still fading|still emerging)\b|\bremains\b/iu

export type NarrativeStage = NarrativeLogEntry["stage"]

export type StageKnown = Readonly<{
  slug: string
  title: string
  stage: NarrativeStage
}>

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
    out.push({ slug: prior.slug, title: prior.title, stage: prior.stage })
  }
  return out
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

/** Distinctive tokens used to recognize a narrative in free text. */
export function narrativeAliases(entry: StageKnown): string[] {
  const aliases = new Set<string>()
  for (const part of entry.slug.split("-")) {
    if (STAGE_STOPWORDS.has(part)) continue
    if (part.length >= 4 || SHORT_ALIAS_ALLOW.has(part)) aliases.add(part)
  }
  for (const word of entry.title.toLowerCase().split(/[^a-z0-9]+/u)) {
    if (STAGE_STOPWORDS.has(word)) continue
    if (word.length >= 4 || SHORT_ALIAS_ALLOW.has(word)) aliases.add(word)
  }
  // Common operator shorthand for Robinhood-chain narratives
  if (entry.slug.includes("rh-") || /\brobinhood\b/iu.test(entry.title)) {
    aliases.add("rh")
  }
  return [...aliases]
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
    const aliases = narrativeAliases(entry)
    if (aliases.length === 0) continue
    const mentioned = aliases.some((alias) =>
      new RegExp(`\\b${escapeRegExp(alias)}\\b`, "iu").test(text),
    )
    if (!mentioned) continue
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
}>): { ok: true } | { ok: false; reason: string } {
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

  return { ok: false, reason: "narrative-unchanged-stage" }
}

export function statusQuoFillerPattern(): RegExp {
  return STATUS_QUO_FILLER
}

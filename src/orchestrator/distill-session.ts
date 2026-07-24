/**
 * Channel distillers — host-side, fail-closed rewrites into per-destination
 * payloads (INV-B2). Fixed host prompts, quoted untrusted input, strict
 * post-checks, never write state.
 *
 * Discord: run-scoped bottom-line, silent on unchanged-stage heat.
 * Telegram intraday: one short topic paragraph per subject group.
 * Telegram daily: section bodies for the narrative map (host renders headers).
 */

import type { AuditClaim } from "../contracts/schemas.js"
import {
  maturedNarrativeLabels,
  preferredNarrativeLabel,
  usesStaleRotationFraming,
} from "../lib/narrative-label.js"
import type { NarrativeFraming } from "../lib/narrative-framing.js"
import { isMatureFraming } from "../lib/narrative-framing.js"
import { hasLocalWorkspaceRefs } from "../lib/telegram-format.js"
import { scrubLeakedHourHorizons, watchWindowClaimFragment } from "../lib/watch-window.js"
import {
  DISCORD_DISTILLER_PROMPT,
  TELEGRAM_DAILY_DIGEST_PROMPT,
  TELEGRAM_TOPIC_PROMPT,
} from "../prompts/host.js"
import {
  restatesUnchangedNarrativeStage,
  statusQuoFillerPattern,
  type StageKnown,
} from "./narrative-stage-dedupe.js"
import type { NarrativeLogEntry } from "./narrative-log.js"

export const DISCORD_TEXT_MAX = 320
export const DISCORD_TICKER_MAX = 3
/** Intraday topic update — one short paragraph, not a briefing */
export const TELEGRAM_TOPIC_TEXT_MAX = 800
/** Daily narrative map hard cap (one Telegram message) */
export const TELEGRAM_DIGEST_TEXT_MAX = 3_400
/** @deprecated Use TELEGRAM_TOPIC_TEXT_MAX — alias for callers/tests */
export const TELEGRAM_TEXT_MAX = TELEGRAM_TOPIC_TEXT_MAX
const TOPIC_SECTION_HEADER = /(?:^|\n)\s*\*\*[^*\n]{2,80}\*\*\s*(?:\n|$)/u
const TOPIC_BULLET_LINE = /(?:^|\n)\s*[-•*]\s+\S/u

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u
const PROVENANCE_HANDLE = /(?:twitter|farcaster):@[\w.-]+/iu
/** Bare @handle — excludes twitter:@ / farcaster:@ (colon precedes @) */
const BARE_AT_HANDLE = /(?<![a-z:])@[\w.-]+/iu
const TICKER_TOKEN = /\$[A-Za-z][A-Za-z0-9]{0,15}\b/gu
const MARKDOWN_BODY_MARKERS = /(?:^|\n)\s*#{1,6}\s|(?:\*\*|__|`)/u

export type DistillSessionRunner = (
  args: Readonly<{ prompt: string; message: string }>,
) => Promise<string>

export type DistillBudgetFraction = Readonly<{
  llmBudgetFraction: number
  hotDayLlmBudgetFraction: number
  hotDayMinStagedEvents: number
  stagedEventsThisRun: number
}>

export type DistillArgs = Readonly<{
  reportText: string
  fallbackText: string
  auditClaim?: AuditClaim
  /** Narratives at unchanged heat — must not be restated at that stage (Discord) */
  unchangedStages?: readonly StageKnown[]
  dailyCap: number
  usedToday: number
  runSession?: DistillSessionRunner
  enabled?: boolean
  /** When set, LLM sessions stop at floor(dailyCap * fraction) with reason llm-budget-fraction */
  budgetFraction?: DistillBudgetFraction
}>

export type TopicPacketMember = Readonly<{
  eventId: string
  severity: string
  text: string
  auditClaim?: AuditClaim
}>

export type TopicNarrativeSnapshot = Readonly<{
  slug: string
  stage: NarrativeLogEntry["stage"]
  tickers: readonly string[]
  lastSeen: string
  title?: string | undefined
  framing?: NarrativeFraming | undefined
}>

function snapshotLabel(entry: Readonly<{
  slug: string
  title?: string | undefined
  framing?: NarrativeFraming | undefined
}>): string {
  return preferredNarrativeLabel({
    slug: entry.slug,
    ...(entry.title ? { title: entry.title } : {}),
    ...(entry.framing ? { framing: entry.framing } : {}),
  })
}

function framingAnnotation(entry: Readonly<{ framing?: NarrativeFraming | undefined }>): string {
  return isMatureFraming(entry.framing) ? ` framing=${entry.framing}` : ""
}

export type TopicPacket = Readonly<{
  subject: string
  subjectLabel: string
  narrative?: TopicNarrativeSnapshot
  members: readonly TopicPacketMember[]
  otherNarratives: readonly TopicNarrativeSnapshot[]
}>

export type TelegramTopicArgs = Readonly<{
  packet: TopicPacket
  fallbackText: string
  dailyCap: number
  usedToday: number
  runSession?: DistillSessionRunner
  enabled?: boolean
  budgetFraction?: DistillBudgetFraction
}>

export type DailyDigestSection = Readonly<{
  slug: string
  body: string
}>

export type DailyDigestPacket = Readonly<{
  londonDate: string
  windowStart: string
  windowEnd: string
  activeNarratives: readonly TopicNarrativeSnapshot[]
  developmentsBySlug: Readonly<Record<string, string>>
}>

export type DistillResult = Readonly<{
  text: string
  usedFallback: boolean
  reason?: string
  used: number
  capExhausted: boolean
}>

export type DailyDigestDistillResult = Readonly<{
  sections: readonly DailyDigestSection[]
  usedFallback: boolean
  reason?: string
  used: number
  capExhausted: boolean
}>

function claimLine(auditClaim?: AuditClaim): string {
  return auditClaim
    ? `type=${auditClaim.type} subject=${auditClaim.subject} direction=${auditClaim.direction} ${watchWindowClaimFragment(auditClaim)}`
    : "type=unknown subject=unknown direction=unknown"
}

function stageList(stages: readonly StageKnown[] | undefined): string {
  const mapped = (stages ?? [])
    .slice(0, 24)
    .map((entry) => {
      const label = preferredNarrativeLabel({
        slug: entry.slug,
        title: entry.title,
        ...(entry.framing ? { framing: entry.framing } : {}),
      })
      const framing = framingAnnotation(entry)
      return `${label}=${entry.stage}${framing}`
    })
    .join(", ")
  return mapped.length > 0 ? mapped : "(none)"
}

function stripFence(raw: string): string {
  let text = raw.trim()
  if (text.startsWith("```") && text.endsWith("```")) {
    text = text.replace(/^```(?:\w+)?\n?/u, "").replace(/\n?```$/u, "").trim()
  }
  return text
}

function charLen(text: string): number {
  return [...text].length
}

function clipChars(text: string, max: number): string {
  if (charLen(text) <= max) return text
  return [...text].slice(0, max).join("")
}

export function distillUserMessage(args: Readonly<{
  reportText: string
  auditClaim?: AuditClaim
  unchangedStages?: readonly StageKnown[]
}>): string {
  return [
    "Rewrite the quoted report as a single Discord bottom-line using the system rules.",
    `auditClaim (context only): ${claimLine(args.auditClaim)}`,
    `unchangedStages: ${stageList(args.unchangedStages)}`,
    "<untrusted-report>",
    args.reportText,
    "</untrusted-report>",
  ].join("\n")
}

export function telegramTopicUserMessage(packet: TopicPacket): string {
  const narrativeLine = packet.narrative
    ? `subjectNarrative: stage=${packet.narrative.stage} lastSeen=${packet.narrative.lastSeen} tickers=${packet.narrative.tickers.join(",") || "(none)"}${framingAnnotation(packet.narrative)}`
    : "subjectNarrative: (none)"
  const otherLine = packet.otherNarratives.length > 0
    ? packet.otherNarratives
      .map((entry) => `${entry.slug}|${snapshotLabel(entry)}|${entry.stage}${framingAnnotation(entry)}`)
      .join("; ")
    : "(none)"
  const members = packet.members.map((member, index) => {
    const claim = member.auditClaim ? claimLine(member.auditClaim) : "auditClaim=(none)"
    return [
      `member[${index}] eventId=${member.eventId} severity=${member.severity}`,
      claim,
      "<untrusted-member-text>",
      member.text,
      "</untrusted-member-text>",
    ].join("\n")
  }).join("\n")
  return [
    "Rewrite the quoted topic packet as one short Telegram topic update using the system rules.",
    `subject=${packet.subject}`,
    `subjectLabel=${packet.subjectLabel}`,
    narrativeLine,
    `otherNarratives (forbidden): ${otherLine}`,
    "<untrusted-topic-packet>",
    members,
    "</untrusted-topic-packet>",
  ].join("\n")
}

/** @deprecated Prefer telegramTopicUserMessage */
export function telegramOverviewUserMessage(args: Readonly<{
  reportText: string
  auditClaim?: AuditClaim
  knownStages?: readonly StageKnown[]
}>): string {
  const subject = args.auditClaim?.subject ?? "unknown"
  const known = args.knownStages?.find((entry) => entry.slug === subject)
  return telegramTopicUserMessage({
    subject,
    subjectLabel: preferredNarrativeLabel({
      slug: subject,
      ...(known?.title ? { title: known.title } : {}),
      ...(known?.framing ? { framing: known.framing } : {}),
    }),
    members: [{
      eventId: "legacy",
      severity: "notable",
      text: args.reportText,
      ...(args.auditClaim ? { auditClaim: args.auditClaim } : {}),
    }],
    otherNarratives: [],
  })
}

export function telegramDailyDigestUserMessage(packet: DailyDigestPacket): string {
  const narratives = packet.activeNarratives.map((entry) => (
    `${entry.slug}|${snapshotLabel(entry)}|${entry.stage}|lastSeen=${entry.lastSeen}|tickers=${entry.tickers.join(",") || "(none)"}${framingAnnotation(entry)}`
  )).join("\n")
  const developments = packet.activeNarratives.map((entry) => {
    const body = packet.developmentsBySlug[entry.slug] ?? ""
    return [
      `slug=${entry.slug}`,
      "<untrusted-developments>",
      body.length > 0 ? body : "(none)",
      "</untrusted-developments>",
    ].join("\n")
  }).join("\n")
  return [
    "Write daily digest section bodies as JSON using the system rules.",
    `londonDate=${packet.londonDate}`,
    `windowStart=${packet.windowStart}`,
    `windowEnd=${packet.windowEnd}`,
    "activeNarratives:",
    narratives,
    "<untrusted-digest-packet>",
    developments,
    "</untrusted-digest-packet>",
  ].join("\n")
}

function mentionsOtherNarrative(
  text: string,
  otherNarratives: readonly TopicNarrativeSnapshot[],
): boolean {
  const lower = text.toLowerCase()
  for (const entry of otherNarratives) {
    const label = snapshotLabel(entry).toLowerCase()
    if (label.length > 0 && lower.includes(label)) return true
    if (lower.includes(entry.slug.toLowerCase())) return true
  }
  return false
}

/** Mechanical Discord style post-check. Returns reason on reject. */
export function validateDiscordDistillOutput(
  raw: string,
  unchangedStages: readonly StageKnown[] = [],
  maturedNarratives: readonly StageKnown[] = [],
): { ok: true; text: string } | { ok: false; reason: string } {
  const text = stripFence(raw)
  if (text.length < 1) return { ok: false, reason: "empty" }
  if (charLen(text) > DISCORD_TEXT_MAX) return { ok: false, reason: "too-long" }
  if (CONTROL_CHARS.test(text)) return { ok: false, reason: "control-chars" }
  if (PROVENANCE_HANDLE.test(text)) return { ok: false, reason: "provenance-handle" }
  if (BARE_AT_HANDLE.test(text)) return { ok: false, reason: "bare-at-handle" }
  const tickers = text.match(TICKER_TOKEN) ?? []
  if (tickers.length > DISCORD_TICKER_MAX) return { ok: false, reason: "ticker-overflow" }
  if (statusQuoFillerPattern().test(text)) return { ok: false, reason: "status-quo-filler" }
  if (
    unchangedStages.length > 0
    && restatesUnchangedNarrativeStage(text, unchangedStages)
  ) {
    return { ok: false, reason: "unchanged-stage-restatement" }
  }
  const matured = maturedNarratives.length > 0
    ? maturedNarratives
    : maturedNarrativeLabels(unchangedStages)
  if (usesStaleRotationFraming(text, matured)) {
    return { ok: false, reason: "stale-narrative-framing" }
  }
  return { ok: true, text: scrubLeakedHourHorizons(text) }
}

/** Mechanical Telegram topic post-check — short paragraph, no briefing layout. */
export function validateTelegramTopicOutput(
  raw: string,
  otherNarratives: readonly TopicNarrativeSnapshot[] = [],
  maturedNarratives: readonly TopicNarrativeSnapshot[] = [],
): { ok: true; text: string } | { ok: false; reason: string } {
  const text = stripFence(raw)
  if (text.length < 1) return { ok: false, reason: "empty" }
  if (charLen(text) > TELEGRAM_TOPIC_TEXT_MAX) return { ok: false, reason: "too-long" }
  if (CONTROL_CHARS.test(text)) return { ok: false, reason: "control-chars" }
  if (PROVENANCE_HANDLE.test(text)) return { ok: false, reason: "provenance-handle" }
  if (BARE_AT_HANDLE.test(text)) return { ok: false, reason: "bare-at-handle" }
  if (hasLocalWorkspaceRefs(text)) return { ok: false, reason: "workspace-path" }
  if (TOPIC_SECTION_HEADER.test(text)) return { ok: false, reason: "section-header" }
  if (TOPIC_BULLET_LINE.test(text)) return { ok: false, reason: "bullet-list" }
  if (mentionsOtherNarrative(text, otherNarratives)) {
    return { ok: false, reason: "cross-topic-mention" }
  }
  if (usesStaleRotationFraming(text, maturedNarrativeLabels(maturedNarratives))) {
    return { ok: false, reason: "stale-narrative-framing" }
  }
  return { ok: true, text: scrubLeakedHourHorizons(text) }
}

/** @deprecated Prefer validateTelegramTopicOutput */
export function validateTelegramOverviewOutput(
  raw: string,
): { ok: true; text: string } | { ok: false; reason: string } {
  return validateTelegramTopicOutput(raw, [])
}

function validatePlainDigestBody(body: string): { ok: true; text: string } | { ok: false; reason: string } {
  const text = body.trim()
  if (text.length < 1) return { ok: false, reason: "empty-body" }
  if (CONTROL_CHARS.test(text)) return { ok: false, reason: "control-chars" }
  if (PROVENANCE_HANDLE.test(text)) return { ok: false, reason: "provenance-handle" }
  if (BARE_AT_HANDLE.test(text)) return { ok: false, reason: "bare-at-handle" }
  if (hasLocalWorkspaceRefs(text)) return { ok: false, reason: "workspace-path" }
  if (MARKDOWN_BODY_MARKERS.test(text)) return { ok: false, reason: "markdown-in-body" }
  return { ok: true, text: scrubLeakedHourHorizons(text) }
}

export function validateTelegramDailyDigestOutput(
  raw: string,
  activeSlugs: readonly string[],
): { ok: true; sections: DailyDigestSection[] } | { ok: false; reason: string } {
  const text = stripFence(raw)
  if (text.length < 1) return { ok: false, reason: "empty" }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: "invalid-json" }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not-object" }
  }
  const sectionsRaw = (parsed as { sections?: unknown }).sections
  if (!Array.isArray(sectionsRaw)) return { ok: false, reason: "sections-not-array" }

  const expected = new Set(activeSlugs)
  if (sectionsRaw.length !== expected.size) return { ok: false, reason: "section-count" }

  const seen = new Set<string>()
  const sections: DailyDigestSection[] = []
  for (const entry of sectionsRaw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, reason: "section-not-object" }
    }
    const record = entry as Record<string, unknown>
    if (typeof record["slug"] !== "string") return { ok: false, reason: "slug-not-string" }
    if (typeof record["body"] !== "string") return { ok: false, reason: "body-not-string" }
    const slug = record["slug"]
    if (!expected.has(slug)) return { ok: false, reason: "unknown-slug" }
    if (seen.has(slug)) return { ok: false, reason: "duplicate-slug" }
    seen.add(slug)
    const body = validatePlainDigestBody(record["body"])
    if (!body.ok) return { ok: false, reason: body.reason }
    sections.push({ slug, body: body.text })
  }
  for (const slug of expected) {
    if (!seen.has(slug)) return { ok: false, reason: "missing-slug" }
  }
  return { ok: true, sections }
}

const STAGE_ORDER: Record<NarrativeLogEntry["stage"], number> = {
  peaking: 0,
  emerging: 1,
  fading: 2,
}

export function sortActiveNarrativesForDigest(
  entries: readonly TopicNarrativeSnapshot[],
): TopicNarrativeSnapshot[] {
  return [...entries].sort((a, b) => {
    const stageDelta = STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage]
    if (stageDelta !== 0) return stageDelta
    const seenDelta = b.lastSeen.localeCompare(a.lastSeen)
    if (seenDelta !== 0) return seenDelta
    return snapshotLabel(a).localeCompare(snapshotLabel(b))
  })
}

/** Narratives with non-empty host-approved window text — quiet slugs stay off the map. */
export function selectDigestNarratives(
  narratives: readonly TopicNarrativeSnapshot[],
  developmentsBySlug: Readonly<Record<string, string>>,
): TopicNarrativeSnapshot[] {
  return sortActiveNarrativesForDigest(
    narratives.filter((entry) => (developmentsBySlug[entry.slug] ?? "").trim().length > 0),
  )
}

export function renderDailyDigestMarkdown(args: Readonly<{
  londonDate: string
  narratives: readonly TopicNarrativeSnapshot[]
  sectionsBySlug: Readonly<Record<string, string>>
}>): string {
  const ordered = sortActiveNarrativesForDigest(args.narratives).filter((entry) => (
    (args.sectionsBySlug[entry.slug] ?? "").trim().length > 0
  ))
  const parts = [`**Daily narrative map — ${args.londonDate}**`]
  for (const entry of ordered) {
    const label = snapshotLabel(entry)
    const body = (args.sectionsBySlug[entry.slug] ?? "").trim()
    parts.push(`**${label} — ${entry.stage}**`)
    parts.push(body)
  }
  return parts.join("\n\n")
}

export function renderTopicFallback(packet: TopicPacket): string {
  const lead = packet.members.map((member) => member.text.trim()).filter((text) => text.length > 0)
  const body = lead.length > 0
    ? lead.join(" ")
    : packet.narrative
      ? `${packet.subjectLabel} ${packet.narrative.stage}.`
      : packet.subjectLabel
  return clipChars(body.replace(/\s+/gu, " ").trim(), TELEGRAM_TOPIC_TEXT_MAX)
}

/**
 * LLM distill sessions may consume only a fraction of dailyCap; hot days use a
 * tighter fraction. Full dailyCap exhaustion stays distinct (cap-exhausted).
 */
export function resolveDistillLlmCap(args: Readonly<{
  dailyCap: number
  usedToday: number
  budgetFraction?: DistillBudgetFraction
}>): { ok: true } | {
  ok: false
  reason: "cap-exhausted" | "llm-budget-fraction"
  capExhausted: boolean
} {
  if (args.usedToday >= args.dailyCap) {
    return { ok: false, reason: "cap-exhausted", capExhausted: true }
  }
  const frac = args.budgetFraction
  if (!frac) return { ok: true }
  const fraction = frac.stagedEventsThisRun >= frac.hotDayMinStagedEvents
    ? frac.hotDayLlmBudgetFraction
    : frac.llmBudgetFraction
  const effectiveCap = Math.floor(args.dailyCap * fraction)
  if (args.usedToday >= effectiveCap) {
    return { ok: false, reason: "llm-budget-fraction", capExhausted: false }
  }
  return { ok: true }
}

/**
 * Compact deterministic daily digest for narratives with window developments.
 * Quiet slugs are omitted (absence is the signal). Returns null when the set
 * is empty or mandatory headers alone exceed the cap.
 */
export function renderDailyDigestCompactFallback(args: Readonly<{
  londonDate: string
  narratives: readonly TopicNarrativeSnapshot[]
  developmentsBySlug: Readonly<Record<string, string>>
}>): string | null {
  const ordered = selectDigestNarratives(args.narratives, args.developmentsBySlug)
  if (ordered.length === 0) return null

  const title = `**Daily narrative map — ${args.londonDate}**`
  const headers = ordered.map((entry) => (
    `**${snapshotLabel(entry)} — ${entry.stage}**`
  ))
  // title + blank line between each header block: n headers → n separators before bodies
  let used = charLen(title)
  for (const header of headers) {
    used += 2 + charLen(header) // \n\n + header
  }
  if (used > TELEGRAM_DIGEST_TEXT_MAX) return null

  const remaining = TELEGRAM_DIGEST_TEXT_MAX - used
  const bodyBudgetPer = Math.floor(remaining / ordered.length)
  const parts: string[] = [title]
  for (const entry of ordered) {
    const header = `**${snapshotLabel(entry)} — ${entry.stage}**`
    const bodySource = (args.developmentsBySlug[entry.slug] ?? "").trim()
    // each body costs \n\n before it
    const bodyMax = Math.max(0, bodyBudgetPer - 2)
    const body = clipChars(bodySource.replace(/\s+/gu, " "), bodyMax)
    parts.push(header)
    if (body.length > 0) parts.push(body)
  }
  const rendered = parts.join("\n\n")
  if (charLen(rendered) > TELEGRAM_DIGEST_TEXT_MAX) return null
  return rendered
}

/**
 * Compress a chat report into a Discord bottom-line. Fail-closed to fallbackText
 * on any miss: disabled, missing runner, cap exhausted, session error, or
 * post-check reject. Host attaches at most one Discord payload per run.
 */
export async function runDiscordDistiller(args: DistillArgs): Promise<DistillResult> {
  const fallback = (reason: string, used: number, capExhausted = false): DistillResult => ({
    text: args.fallbackText,
    usedFallback: true,
    reason,
    used,
    capExhausted,
  })

  if (args.enabled === false) {
    return fallback("disabled", args.usedToday)
  }
  const cap = resolveDistillLlmCap({
    dailyCap: args.dailyCap,
    usedToday: args.usedToday,
    ...(args.budgetFraction ? { budgetFraction: args.budgetFraction } : {}),
  })
  if (!cap.ok) {
    return fallback(cap.reason, args.usedToday, cap.capExhausted)
  }
  if (!args.runSession) {
    return fallback("no-runner", args.usedToday)
  }

  const used = args.usedToday + 1
  const unchanged = args.unchangedStages ?? []
  try {
    const raw = await args.runSession({
      prompt: DISCORD_DISTILLER_PROMPT,
      message: distillUserMessage({
        reportText: args.reportText,
        ...(args.auditClaim ? { auditClaim: args.auditClaim } : {}),
        ...(unchanged.length > 0 ? { unchangedStages: unchanged } : {}),
      }),
    })
    const checked = validateDiscordDistillOutput(raw, unchanged)
    if (!checked.ok) return fallback(checked.reason, used)
    return { text: checked.text, usedFallback: false, used, capExhausted: false }
  } catch {
    return fallback("session-error", used)
  }
}

/**
 * Rewrite a bounded topic packet into one short Telegram topic update.
 * Fail-closed to packet fallback on any miss.
 */
export async function runTelegramTopicDistiller(
  args: TelegramTopicArgs,
): Promise<DistillResult> {
  const fallbackText = clipChars(
    args.fallbackText.length > 0 ? args.fallbackText : renderTopicFallback(args.packet),
    TELEGRAM_TOPIC_TEXT_MAX,
  )
  const fallback = (reason: string, used: number, capExhausted = false): DistillResult => ({
    text: fallbackText,
    usedFallback: true,
    reason,
    used,
    capExhausted,
  })

  if (args.enabled === false) {
    return fallback("disabled", args.usedToday)
  }
  const cap = resolveDistillLlmCap({
    dailyCap: args.dailyCap,
    usedToday: args.usedToday,
    ...(args.budgetFraction ? { budgetFraction: args.budgetFraction } : {}),
  })
  if (!cap.ok) {
    return fallback(cap.reason, args.usedToday, cap.capExhausted)
  }
  if (!args.runSession) {
    return fallback("no-runner", args.usedToday)
  }

  const used = args.usedToday + 1
  try {
    const raw = await args.runSession({
      prompt: TELEGRAM_TOPIC_PROMPT,
      message: telegramTopicUserMessage(args.packet),
    })
    const checked = validateTelegramTopicOutput(
      raw,
      args.packet.otherNarratives,
      [
        ...(args.packet.narrative ? [args.packet.narrative] : []),
        ...args.packet.otherNarratives,
      ],
    )
    if (!checked.ok) return fallback(checked.reason, used)
    return { text: checked.text, usedFallback: false, used, capExhausted: false }
  } catch {
    return fallback("session-error", used)
  }
}

/** @deprecated Prefer runTelegramTopicDistiller */
export async function runTelegramOverviewDistiller(
  args: Readonly<{
    reportText: string
    fallbackText: string
    auditClaim?: AuditClaim
    knownStages?: readonly StageKnown[]
    dailyCap: number
    usedToday: number
    runSession?: DistillSessionRunner
    enabled?: boolean
  }>,
): Promise<DistillResult> {
  const subject = args.auditClaim?.subject ?? "unknown"
  const known = args.knownStages?.find((entry) => entry.slug === subject)
  return runTelegramTopicDistiller({
    packet: {
      subject,
      subjectLabel: preferredNarrativeLabel({
        slug: subject,
        ...(known?.title ? { title: known.title } : {}),
        ...(known?.framing ? { framing: known.framing } : {}),
      }),
      ...(known ? {
        narrative: {
          slug: known.slug,
          stage: known.stage,
          tickers: [],
          lastSeen: "",
          title: known.title,
          ...(known.framing ? { framing: known.framing } : {}),
        },
      } : {}),
      members: [{
        eventId: "legacy",
        severity: "notable",
        text: args.reportText,
        ...(args.auditClaim ? { auditClaim: args.auditClaim } : {}),
      }],
      otherNarratives: [],
    },
    fallbackText: args.fallbackText,
    dailyCap: args.dailyCap,
    usedToday: args.usedToday,
    ...(args.runSession ? { runSession: args.runSession } : {}),
    ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
  })
}

/**
 * Produce validated daily-digest section bodies. Fail-closed to empty sections
 * (caller builds compact fallback).
 */
export async function runTelegramDailyDigestDistiller(args: Readonly<{
  packet: DailyDigestPacket
  dailyCap: number
  usedToday: number
  runSession?: DistillSessionRunner
  enabled?: boolean
}>): Promise<DailyDigestDistillResult> {
  const empty = (reason: string, used: number, capExhausted = false): DailyDigestDistillResult => ({
    sections: [],
    usedFallback: true,
    reason,
    used,
    capExhausted,
  })

  if (args.enabled === false) {
    return empty("disabled", args.usedToday)
  }
  if (args.usedToday >= args.dailyCap) {
    return empty("cap-exhausted", args.usedToday, true)
  }
  if (!args.runSession) {
    return empty("no-runner", args.usedToday)
  }

  const used = args.usedToday + 1
  const activeSlugs = args.packet.activeNarratives.map((entry) => entry.slug)
  try {
    const raw = await args.runSession({
      prompt: TELEGRAM_DAILY_DIGEST_PROMPT,
      message: telegramDailyDigestUserMessage(args.packet),
    })
    const checked = validateTelegramDailyDigestOutput(raw, activeSlugs)
    if (!checked.ok) return empty(checked.reason, used)
    const rendered = renderDailyDigestMarkdown({
      londonDate: args.packet.londonDate,
      narratives: args.packet.activeNarratives,
      sectionsBySlug: Object.fromEntries(
        checked.sections.map((section) => [section.slug, section.body]),
      ),
    })
    if (charLen(rendered) > TELEGRAM_DIGEST_TEXT_MAX) {
      return empty("too-long", used)
    }
    return { sections: checked.sections, usedFallback: false, used, capExhausted: false }
  } catch {
    return empty("session-error", used)
  }
}

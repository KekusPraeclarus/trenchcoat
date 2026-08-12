import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  createDiscordRestClient,
  type DiscordHistoryMessage,
  type DiscordRestClient,
} from "../discord/bot-client.js"
import { fetchChannelWindow } from "../discord/history.js"
import { writeAtomicFileFsync } from "../lib/fs-atomic.js"
import { loadConfig } from "../lib/config.js"
import { systemClock } from "../lib/clock.js"
import { log } from "../lib/log.js"
import { ACTIVE_REMEDIATION_PHASES } from "./schemas.js"
import type {
  RemediationCursorsFile,
  RemediationIncident,
  SuggestionCategory,
  SuggestionClassifierBatch,
  SuggestionClassifierThreadResult,
  SuggestionLedgerEntry,
  SuggestionLedgerFile,
  SuggestionOutcome,
} from "./schemas.js"
import {
  shortIncidentId,
  sanitizeSecretLike,
  stableIncidentFingerprint,
} from "./sanitize.js"
import type { RemediationLayout } from "./paths.js"
import type { RemediationStore } from "./store.js"
import { upsertIncident } from "./store.js"
import { runSuggestionClassifier } from "./agents.js"

export const AMBIENT_THREAD_GAP_MS = 5 * 60_000
export const FORMING_TTL_MS = 7 * 86_400_000
export const MAX_FORMING_ROUNDS = 5
export const MAX_ANCESTOR_DEPTH = 50
export const MIN_SUGGESTION_CONFIDENCE = 0.7
export const MAX_NEW_SUGGESTION_INCIDENTS_PER_SCAN = 3
export const MAX_ACTIVE_SUGGESTION_INCIDENTS = 1
export const DUPLICATE_WINDOW_MS = 30 * 86_400_000
export const MAX_CLASSIFIER_FAILURES = 3
export const MAX_FOLLOWUP_QUESTION_CHARS = 280
export const SUGGESTION_FOLLOWUP_PREFIX = "I logged this as a suggestion but need more detail."
export const SUGGESTION_FOLLOWUP_FALLBACK = "What should happen instead?"

/**
 * A thread must ask for something AND name a product surface. A bare mention no
 * longer admits a thread, because most mentions are chat, not requests.
 */
const REQUEST_RE = /\b(bug|broken|fix|fixes|feature|should|shouldn'?t|please|add|adds|improve|change|update|idea|suggestion|wishlist|todo|implement|support|enable|disable|need|needs|want|wants|could|would|consider|missing|stop|start|instead|prefer|too (?:many|much|long|short|noisy)|noisy|spammy)\b/iu
const PRODUCT_SURFACE_RE = /\b(bot|broadcast|broadcasts|telegram|discord|digest|narrative|narratives|watchlist|wallet|wallets|research|alert|alerts|report|reports|chat|scan|scans|feed|message|messages|notification|notifications|summary|signal|signals|command|cli|status|health|dashboard|queue|harness|outcome|outcomes|score|scores|chart|charts|annotation|annotations)\b/iu
const OUT_OF_SCOPE_RE = /\b(trade|swap|execute order|private key|api key|credentials?|moderat|ban user|kick user|tweet|post on (x|twitter)|new external service|oauth secret)\b/iu
const DENY_SURFACE_RE = /\b(src\/remediation|agent\/skills|agent\/AGENTS|\.env\b|archive\/|decision-policy|harness_improvement)\b/iu

export type ThreadMessage = DiscordHistoryMessage & Readonly<{
  inWindow: boolean
  isAncestor: boolean
}>

export type ConversationThread = Readonly<{
  threadId: string
  channelId: string
  messages: readonly ThreadMessage[]
  humanMessageIds: readonly string[]
  participantIds: readonly string[]
  contentFingerprint: string
  formingEntryId?: string
}>

function normalizeTokens(text: string): string {
  return text
    .toLowerCase()
    .replace(/<@!?\d+>/gu, " ")
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/[^a-z0-9\s]/gu, " ")
    .split(/\s+/u)
    .filter((t) => t.length > 2)
    .sort()
    .join(" ")
}

export function threadContentFingerprint(
  messages: readonly DiscordHistoryMessage[],
): string {
  const human = messages
    .filter((m) => !m.authorIsBot && !m.authorIsWebhook)
    .map((m) => normalizeTokens(m.content))
    .filter(Boolean)
    .join("|")
  return createHash("sha256").update(human).digest("hex").slice(0, 24)
}

export function incidentSuggestionFingerprint(
  category: SuggestionCategory,
  summary: string,
): string {
  return stableIncidentFingerprint({
    component: "discord-suggestion",
    errorClass: category,
    target: createHash("sha256")
      .update(normalizeTokens(summary))
      .digest("hex")
      .slice(0, 16),
  })
}

function mentionStripped(content: string): string {
  return content
    .replace(/<@!?\d+>/gu, "@user")
    .replace(/<#\d+>/gu, "#channel")
    .replace(/<@&\d+>/gu, "@role")
}

export function sanitizeMessageContent(content: string): string {
  return sanitizeSecretLike(mentionStripped(content), 2_000)
}

/**
 * Builds the one clarifying question the bot posts for a forming suggestion.
 * The classifier text is untrusted, so the host strips links and mentions,
 * keeps the question on one line, and falls back to a fixed question.
 */
export function renderSuggestionFollowup(question?: string): string {
  const cleaned = sanitizeSecretLike(
    (question ?? "")
      .replace(/https?:\/\/\S+/giu, " ")
      .replace(/www\.\S+/giu, " ")
      .replace(/<[@#][!&]?\d+>/gu, " ")
      .replace(/@(?:everyone|here)\b/giu, " ")
      .replace(/@/gu, " ")
      .replace(/[`*_~|<>]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
    MAX_FOLLOWUP_QUESTION_CHARS,
  ).trim()
  // Only a real question earns a reply, so hostile fragments get the fallback
  const usable = cleaned.length >= 8 && cleaned.includes("?")
  return `${SUGGESTION_FOLLOWUP_PREFIX} ${usable ? cleaned : SUGGESTION_FOLLOWUP_FALLBACK}`
}

/** Last human message in the scan window — the thread turn the bot answers. */
export function followupReplyTargetId(
  thread: ConversationThread,
): string | undefined {
  const human = thread.messages.filter((m) =>
    m.inWindow && !m.authorIsBot && !m.authorIsWebhook,
  )
  return human.at(-1)?.id
}

/**
 * Asks at most one question per suggestion entry, on the first forming round.
 * A send failure leaves the ledger fields unset so the next scan can retry.
 */
export async function maybePostSuggestionFollowup(args: Readonly<{
  client: DiscordRestClient
  ledger: SuggestionLedgerFile
  entryId: string
  channelId: string
  replyToMessageId: string
  question?: string
  enabled: boolean
  nowIso: string
}>): Promise<{ ledger: SuggestionLedgerFile; posted: boolean }> {
  if (!args.enabled) return { ledger: args.ledger, posted: false }
  const entry = args.ledger.entries.find((e) => e.entryId === args.entryId)
  if (!entry) return { ledger: args.ledger, posted: false }
  if (entry.outcome !== "forming") return { ledger: args.ledger, posted: false }
  if (entry.followupMessageId) return { ledger: args.ledger, posted: false }
  if (entry.formingRounds !== 1) return { ledger: args.ledger, posted: false }

  try {
    const sent = await args.client.sendReply({
      channelId: args.channelId,
      content: renderSuggestionFollowup(args.question),
      replyToMessageId: args.replyToMessageId,
    })
    return {
      ledger: upsertLedgerEntry(args.ledger, {
        ...entry,
        followupMessageId: sent.messageId,
        followupAskedAt: args.nowIso,
        updatedAt: args.nowIso,
      }),
      posted: true,
    }
  } catch (error) {
    log.warn("suggestion followup send failed", {
      entryId: args.entryId,
      detail: error instanceof Error ? error.message : "unknown",
    })
    return { ledger: args.ledger, posted: false }
  }
}

/**
 * Posts follow-ups for forming entries that missed the ask on an earlier scan
 * (for example when the feature shipped after the entry was already forming).
 */
export async function backfillPendingSuggestionFollowups(args: Readonly<{
  client: DiscordRestClient
  ledger: SuggestionLedgerFile
  enabled: boolean
  nowIso: string
}>): Promise<{ ledger: SuggestionLedgerFile; posted: number }> {
  if (!args.enabled) return { ledger: args.ledger, posted: 0 }
  let ledger = args.ledger
  let posted = 0
  for (const entry of ledger.entries) {
    if (entry.outcome !== "forming") continue
    if (entry.followupMessageId) continue
    if (entry.formingRounds !== 1) continue
    const replyToMessageId = entry.humanMessageIds.at(-1)
    if (!replyToMessageId) continue
    const result = await maybePostSuggestionFollowup({
      client: args.client,
      ledger,
      entryId: entry.entryId,
      channelId: entry.channelId,
      replyToMessageId,
      enabled: true,
      nowIso: args.nowIso,
    })
    ledger = result.ledger
    if (result.posted) posted += 1
  }
  return { ledger, posted }
}

/**
 * Admit a thread only when the operator asks for something about a product
 * surface. Both signals may come from different messages in the same thread.
 */
export function hasSuggestionSignal(
  messages: readonly DiscordHistoryMessage[],
): boolean {
  let request = false
  let surface = false
  for (const m of messages) {
    if (m.authorIsBot || m.authorIsWebhook) continue
    if (REQUEST_RE.test(m.content)) request = true
    if (PRODUCT_SURFACE_RE.test(m.content)) surface = true
    if (request && surface) return true
  }
  return false
}

/**
 * A criterion is measurable when a reader can check it without judgement: it
 * names a number, a comparison, or a deterministic observable verb.
 */
const MEASURABLE_RE = /(\d|\bat (?:most|least)\b|\bno more than\b|\bexactly\b|\bwithin\b|\bequals?\b|\breturns?\b|\bshows?\b|\bcontains?\b|\bexcludes?\b|\bomits?\b|\brejects?\b|\bwrites?\b|\blogs?\b|\bexits?\b|\bfails?\b|\bpasses?\b|\bmatches\b|\bis (?:true|false|absent|present|empty)\b)/iu

export function isMeasurableCriterion(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 8) return false
  return MEASURABLE_RE.test(trimmed)
}

export type FormedContractCheck =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; downgrade: "forming" | "classifier-failed"; reason: string }>

/**
 * A formed suggestion must carry a testable decision: the symptom, the intended
 * behavior, and one to five measurable acceptance criteria. Missing intended
 * behavior means the idea is still forming; anything else is a classifier fault.
 * When the classifier lists competing complete proposals, it must also say why
 * it picked one.
 */
export function checkFormedContract(
  result: SuggestionClassifierThreadResult,
): FormedContractCheck {
  const intended = result.intendedBehavior?.trim() ?? ""
  if (!intended) {
    return {
      ok: false,
      downgrade: "forming",
      reason: "missing-intended-behavior",
    }
  }
  if (!result.symptom?.trim()) {
    return { ok: false, downgrade: "classifier-failed", reason: "missing-symptom" }
  }
  const criteria = result.acceptanceCriteria ?? []
  if (criteria.length < 1 || criteria.length > 5) {
    return {
      ok: false,
      downgrade: "classifier-failed",
      reason: "acceptance-criteria-count",
    }
  }
  if (!criteria.every(isMeasurableCriterion)) {
    return {
      ok: false,
      downgrade: "classifier-failed",
      reason: "acceptance-criteria-not-measurable",
    }
  }
  if ((result.alternativesConsidered?.length ?? 0) > 0
    && !result.recommendationRationale?.trim()) {
    return {
      ok: false,
      downgrade: "classifier-failed",
      reason: "missing-recommendation-rationale",
    }
  }
  return { ok: true }
}

export function groupIntoThreads(
  windowMessages: readonly DiscordHistoryMessage[],
  ambientGapMs = AMBIENT_THREAD_GAP_MS,
): ConversationThread[] {
  if (windowMessages.length === 0) return []
  const byId = new Map(windowMessages.map((m) => [m.id, m]))
  const sorted = [...windowMessages].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  )
  const assigned = new Set<string>()
  const threads: ConversationThread[] = []

  const collectReplyThread = (seed: DiscordHistoryMessage): DiscordHistoryMessage[] => {
    const ids = new Set<string>()
    const walkUp = (id: string) => {
      let current = byId.get(id)
      while (current && !ids.has(current.id)) {
        ids.add(current.id)
        if (!current.referencedMessageId) break
        current = byId.get(current.referencedMessageId)
      }
    }
    walkUp(seed.id)
    let grew = true
    while (grew) {
      grew = false
      for (const other of sorted) {
        if (ids.has(other.id)) continue
        if (other.referencedMessageId && ids.has(other.referencedMessageId)) {
          ids.add(other.id)
          grew = true
        }
      }
    }
    return sorted.filter((m) => ids.has(m.id))
  }

  for (const msg of sorted) {
    if (assigned.has(msg.id)) continue
    if (!msg.referencedMessageId || !byId.has(msg.referencedMessageId)) continue
    const chain = collectReplyThread(msg)
    if (chain.length === 0) continue
    for (const m of chain) assigned.add(m.id)
    threads.push(threadFromMessages(chain.map((m) => ({
      ...m,
      inWindow: true,
      isAncestor: false,
    }))))
  }

  for (const msg of sorted) {
    if (assigned.has(msg.id)) continue
    const ambient: DiscordHistoryMessage[] = [msg]
    assigned.add(msg.id)
    let lastTs = Date.parse(msg.timestamp)
    for (const other of sorted) {
      if (assigned.has(other.id)) continue
      if (other.referencedMessageId && byId.has(other.referencedMessageId)) continue
      const ts = Date.parse(other.timestamp)
      if (ts - lastTs <= ambientGapMs) {
        ambient.push(other)
        assigned.add(other.id)
        lastTs = ts
      }
    }
    threads.push(threadFromMessages(ambient.map((m) => ({
      ...m,
      inWindow: true,
      isAncestor: false,
    }))))
  }

  return threads
}

function threadFromMessages(messages: readonly ThreadMessage[]): ConversationThread {
  const humanMessageIds = messages
    .filter((m) => m.inWindow && !m.authorIsBot && !m.authorIsWebhook)
    .map((m) => m.id)
  const participantIds = [...new Set(
    messages
      .filter((m) => !m.authorIsBot && !m.authorIsWebhook)
      .map((m) => m.authorId),
  )]
  const channelId = messages[0]?.channelId ?? "0"
  const fingerprint = threadContentFingerprint(messages)
  const threadId = `th-${channelId.slice(-6)}-${fingerprint.slice(0, 12)}`
  return {
    threadId,
    channelId,
    messages,
    humanMessageIds,
    participantIds,
    contentFingerprint: fingerprint,
  }
}

export async function expandReplyAncestors(
  client: DiscordRestClient,
  threads: readonly ConversationThread[],
): Promise<ConversationThread[]> {
  if (!client.getMessage) return [...threads]
  const getMessage = client.getMessage.bind(client)
  const expanded: ConversationThread[] = []
  for (const thread of threads) {
    const byId = new Map(thread.messages.map((m) => [m.id, m]))
    const queue = thread.messages
      .map((m) => m.referencedMessageId)
      .filter((id): id is string => Boolean(id) && !byId.has(id!))
    let depth = 0
    while (queue.length > 0 && depth < MAX_ANCESTOR_DEPTH) {
      const messageId = queue.shift()!
      if (byId.has(messageId)) continue
      depth += 1
      const fetched = await getMessage({
        channelId: thread.channelId,
        messageId,
      })
      if (!fetched) continue
      const ancestor: ThreadMessage = {
        ...fetched,
        inWindow: false,
        isAncestor: true,
      }
      byId.set(ancestor.id, ancestor)
      if (ancestor.referencedMessageId && !byId.has(ancestor.referencedMessageId)) {
        queue.push(ancestor.referencedMessageId)
      }
    }
    const messages = [...byId.values()].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    )
    expanded.push(threadFromMessages(messages))
  }
  return expanded
}

export { fetchChannelWindow }

function upsertLedgerEntry(
  file: SuggestionLedgerFile,
  entry: SuggestionLedgerEntry,
): SuggestionLedgerFile {
  const others = file.entries.filter((e) => e.entryId !== entry.entryId)
  return {
    ...file,
    entries: [entry, ...others].slice(0, 5_000),
  }
}

function findRecentByFingerprint(
  file: SuggestionLedgerFile,
  fingerprint: string,
  nowMs: number,
): SuggestionLedgerEntry | undefined {
  return file.entries.find((e) => (
    e.contentFingerprint === fingerprint
    && nowMs - Date.parse(e.createdAt) <= DUPLICATE_WINDOW_MS
  ))
}

function isBuiltOutcome(outcome: SuggestionOutcome): boolean {
  return outcome === "built" || outcome === "queued"
}

export function stageAPrefilter(args: Readonly<{
  thread: ConversationThread
  ledger: SuggestionLedgerFile
  nowIso: string
  channelAllowed: boolean
}>): {
  outcome?: SuggestionOutcome
  reason?: string
  extendsIncidentId?: string
  priorEntry?: SuggestionLedgerEntry
} {
  if (!args.channelAllowed) {
    return { outcome: "not-eligible", reason: "unconfigured-channel" }
  }
  if (args.thread.humanMessageIds.length === 0) {
    return { outcome: "not-eligible", reason: "no-human-message" }
  }
  const hasAlpha = args.thread.messages.some((m) => /[a-z0-9]/iu.test(m.content))
  if (!hasAlpha) {
    return { outcome: "not-eligible", reason: "no-alphanumeric-content" }
  }

  const humanIds = new Set(args.thread.humanMessageIds)
  const allKnown = [...humanIds].every((id) =>
    args.ledger.entries.some((e) => e.humanMessageIds.includes(id)
      && e.outcome !== "forming"
      && e.outcome !== "queued-waiting"),
  )
  if (allKnown) {
    return { outcome: "already-scanned", reason: "messages-already-ledgered" }
  }

  const nowMs = Date.parse(args.nowIso)
  const prior = findRecentByFingerprint(
    args.ledger,
    args.thread.contentFingerprint,
    nowMs,
  )
  if (prior) {
    if (isBuiltOutcome(prior.outcome) && prior.incidentId) {
      return {
        extendsIncidentId: prior.incidentId,
        priorEntry: prior,
      }
    }
    if (prior.outcome === "forming") {
      return { priorEntry: prior }
    }
    return {
      outcome: "duplicate-suggestion",
      reason: `prior:${prior.outcome}`,
      priorEntry: prior,
    }
  }

  if (!hasSuggestionSignal(args.thread.messages)) {
    return { outcome: "no-suggestion-signal", reason: "no-vocabulary-or-mention" }
  }
  return {}
}

export function hostWorthBuildingGate(args: Readonly<{
  category: SuggestionCategory
  summary: string
  activeSuggestionIncidents: number
  newThisScan: number
  incidents: readonly RemediationIncident[]
  extendsIncidentId?: string
  maxNewPerScan?: number
  maxActive?: number
}>): { outcome?: SuggestionOutcome; reason?: string } {
  if (OUT_OF_SCOPE_RE.test(args.summary)) {
    return { outcome: "out-of-scope", reason: "summary-implies-forbidden-domain" }
  }
  if (DENY_SURFACE_RE.test(args.summary)) {
    return { outcome: "deny-surface", reason: "summary-maps-to-deny-paths" }
  }

  const maxNew = args.maxNewPerScan ?? MAX_NEW_SUGGESTION_INCIDENTS_PER_SCAN
  const maxActive = args.maxActive ?? MAX_ACTIVE_SUGGESTION_INCIDENTS
  if (args.newThisScan >= maxNew || args.activeSuggestionIncidents >= maxActive) {
    return { outcome: "capacity", reason: "suggestion-capacity" }
  }

  const fingerprint = incidentSuggestionFingerprint(args.category, args.summary)
  const extendCreatedAt = args.extendsIncidentId
    ? args.incidents.find((i) => i.incidentId === args.extendsIncidentId)?.createdAt
    : undefined
  const extendMs = extendCreatedAt ? Date.parse(extendCreatedAt) : 0

  const duplicate = args.incidents.find((i) => {
    if (i.origin !== "discord-suggestion") return false
    if (i.fingerprint !== fingerprint) return false
    if (args.extendsIncidentId) {
      return Date.parse(i.createdAt) > extendMs
        && i.incidentId !== args.extendsIncidentId
    }
    return (
      (ACTIVE_REMEDIATION_PHASES as Set<string>).has(i.phase)
      || i.phase === "completed"
      || i.phase === "awaiting-approval"
    )
  })
  if (duplicate) {
    return { outcome: "duplicate-incident", reason: `incident:${duplicate.incidentId}` }
  }
  return {}
}

async function writeThreadEvidence(args: Readonly<{
  layout: RemediationLayout
  thread: ConversationThread
  nowIso: string
  formingNote?: string
  extendsSummary?: string
}>): Promise<string> {
  mkdirSync(args.layout.suggestionEvidence, { recursive: true, mode: 0o700 })
  const path = join(
    args.layout.suggestionEvidence,
    `${args.thread.threadId}-${args.nowIso.replace(/[:.]/gu, "-")}.json`,
  )
  const body = {
    schema: 1,
    trust: "untrusted-external" as const,
    threadId: args.thread.threadId,
    channelId: args.thread.channelId,
    contentFingerprint: args.thread.contentFingerprint,
    capturedAt: args.nowIso,
    ...(args.formingNote ? { priorFormingNote: sanitizeSecretLike(args.formingNote, 500) } : {}),
    ...(args.extendsSummary
      ? { extendsPriorSummary: sanitizeSecretLike(args.extendsSummary, 500) }
      : {}),
    messages: args.thread.messages.map((m) => ({
      id: m.id,
      authorId: m.authorId,
      authorIsBot: m.authorIsBot,
      authorIsWebhook: m.authorIsWebhook,
      inWindow: m.inWindow,
      isAncestor: m.isAncestor,
      timestamp: m.timestamp,
      content: sanitizeMessageContent(m.content),
      ...(m.referencedMessageId ? { referencedMessageId: m.referencedMessageId } : {}),
    })),
  }
  await writeAtomicFileFsync(path, `${JSON.stringify(body, null, 2)}\n`, 0o600)
  return path
}

function linkFormingEntries(
  threads: readonly ConversationThread[],
  ledger: SuggestionLedgerFile,
  nowIso: string,
): ConversationThread[] {
  const nowMs = Date.parse(nowIso)
  const forming = ledger.entries.filter((e) => e.outcome === "forming")
  return threads.map((thread) => {
    const linked = forming.find((entry) => {
      if (entry.channelId !== thread.channelId) return false
      const idleMs = nowMs - Date.parse(entry.lastActivityAt)
      if (idleMs > FORMING_TTL_MS) return false
      const overlapParticipants = thread.participantIds.some((p) =>
        entry.participantIds.includes(p),
      )
      const overlapMessages = thread.messages.some((m) =>
        entry.allMessageIds.includes(m.id)
        || (m.referencedMessageId && entry.allMessageIds.includes(m.referencedMessageId)),
      )
      return overlapMessages || (
        overlapParticipants && entry.contentFingerprint === thread.contentFingerprint
      )
    })
    if (!linked) return thread
    return { ...thread, formingEntryId: linked.entryId }
  })
}

function expireForming(ledger: SuggestionLedgerFile, nowIso: string): SuggestionLedgerFile {
  const nowMs = Date.parse(nowIso)
  let next = ledger
  for (const entry of ledger.entries) {
    if (entry.outcome !== "forming") continue
    if (nowMs - Date.parse(entry.lastActivityAt) <= FORMING_TTL_MS) continue
    next = upsertLedgerEntry(next, {
      ...entry,
      outcome: "formation-expired",
      reason: "no-activity-7d",
      updatedAt: nowIso,
    })
  }
  return next
}

export type SuggestionScanResult = Readonly<{
  threadsSeen: number
  outcomes: Readonly<Record<string, number>>
  incidentsCreated: number
  classifierFailed: boolean
}>

export async function scanDiscordSuggestions(args: Readonly<{
  store: RemediationStore
  layout: RemediationLayout
  repoRoot: string
  nowIso?: string
  client?: DiscordRestClient
  runClassifier?: typeof runSuggestionClassifier
}>): Promise<SuggestionScanResult> {
  const config = loadConfig()
  const ir = config.incident_remediation
  const ds = ir.discord_suggestions
  const outcomes: Record<string, number> = {}
  const bump = (key: string) => {
    outcomes[key] = (outcomes[key] ?? 0) + 1
  }

  if (!ir.enabled || !ds.enabled) {
    return { threadsSeen: 0, outcomes: { disabled: 1 }, incidentsCreated: 0, classifierFailed: false }
  }
  if (!config.chat.discord.enabled) {
    return {
      threadsSeen: 0,
      outcomes: { "discord-disabled": 1 },
      incidentsCreated: 0,
      classifierFailed: false,
    }
  }

  const token = process.env["DISCORD_RESEARCH_BOT_TOKEN"]
  if (!token && !args.client) {
    return { threadsSeen: 0, outcomes: { "missing-token": 1 }, incidentsCreated: 0, classifierFailed: false }
  }

  const channelIds = ds.channel_ids.length > 0
    ? ds.channel_ids
    : config.chat.discord.channel_ids
  const allowed = new Set(channelIds)
  const nowIso = args.nowIso ?? systemClock.nowIso()
  const client = args.client ?? createDiscordRestClient(token!)
  const runClassifier = args.runClassifier ?? runSuggestionClassifier

  let cursors = args.store.loadCursors()
  let ledger = expireForming(args.store.loadSuggestions(), nowIso)
  let incidentsFile = args.store.load()
  let incidentsCreated = 0
  let newThisScan = 0
  let threadsSeen = 0

  const applyFollowupBackfill = async (ledgerIn: SuggestionLedgerFile) => {
    const backfill = await backfillPendingSuggestionFollowups({
      client,
      ledger: ledgerIn,
      enabled: ds.followup_enabled,
      nowIso,
    })
    if (backfill.posted > 0) {
      outcomes["followup-asked"] = (outcomes["followup-asked"] ?? 0) + backfill.posted
    }
    return backfill.ledger
  }

  // Admit queued-waiting first (oldest first)
  const waiting = [...ledger.queuedWaiting].sort(
    (a, b) => Date.parse(a.enqueuedAt) - Date.parse(b.enqueuedAt),
  )
  const stillWaiting: typeof waiting = []
  for (const wait of waiting) {
    const entry = ledger.entries.find((e) => e.entryId === wait.entryId)
    if (!entry || entry.outcome !== "queued-waiting") continue
    if (!entry.category || !entry.summary) {
      stillWaiting.push(wait)
      continue
    }
    const activeSuggestion = incidentsFile.incidents.filter((i) =>
      i.origin === "discord-suggestion"
      && (ACTIVE_REMEDIATION_PHASES as Set<string>).has(i.phase),
    ).length
    const gate = hostWorthBuildingGate({
      category: entry.category,
      summary: entry.summary,
      activeSuggestionIncidents: activeSuggestion,
      newThisScan,
      incidents: incidentsFile.incidents,
      ...(entry.extendsIncidentId ? { extendsIncidentId: entry.extendsIncidentId } : {}),
      maxNewPerScan: ds.max_new_incidents_per_scan,
      maxActive: ds.max_active_suggestion_incidents,
    })
    if (gate.outcome === "capacity") {
      stillWaiting.push(wait)
      continue
    }
    if (gate.outcome) {
      ledger = upsertLedgerEntry(ledger, {
        ...entry,
        outcome: gate.outcome,
        reason: gate.reason,
        updatedAt: nowIso,
      })
      bump(gate.outcome)
      continue
    }
    const created = await createSuggestionIncident({
      store: args.store,
      layout: args.layout,
      entry,
      nowIso,
      incidentsFile,
    })
    incidentsFile = created.incidentsFile
    ledger = created.ledger
    incidentsCreated += 1
    newThisScan += 1
    bump("queued")
  }
  ledger = { ...ledger, queuedWaiting: stillWaiting }

  const pendingThreads: Array<{
    thread: ConversationThread
    evidencePath: string
    extendsIncidentId?: string
    priorForming?: SuggestionLedgerEntry
  }> = []

  for (const channelId of channelIds) {
    const after = cursors.discordChannelCursors[channelId]
    let newestInChannel = after
    const windowMessages = await fetchChannelWindow({
      client,
      channelId,
      ...(after ? { after } : {}),
      onPage: async ({ newestId }) => {
        if (!newestId) return
        newestInChannel = newestId
        cursors = {
          ...cursors,
          discordScanCheckpoint: {
            channelId,
            ...(after ? { after } : {}),
            lastMessageId: newestId,
            updatedAt: nowIso,
          },
        }
        await args.store.saveCursors(cursors)
      },
    })

    let threads = groupIntoThreads(windowMessages, ds.ambient_thread_gap_ms)
    threads = await expandReplyAncestors(client, threads)
    threads = linkFormingEntries(threads, ledger, nowIso)
    threadsSeen += threads.length

    for (const thread of threads) {
      const pre = stageAPrefilter({
        thread,
        ledger,
        nowIso,
        channelAllowed: allowed.has(channelId),
      })
      if (pre.outcome) {
        const entryId = `sug-${thread.contentFingerprint.slice(0, 12)}`
        ledger = upsertLedgerEntry(ledger, {
          schema: 1,
          entryId,
          threadId: thread.threadId,
          channelId,
          contentFingerprint: thread.contentFingerprint,
          outcome: pre.outcome,
          reason: pre.reason,
          humanMessageIds: [...thread.humanMessageIds],
          allMessageIds: thread.messages.map((m) => m.id),
          participantIds: [...thread.participantIds],
          formingRounds: 0,
          createdAt: nowIso,
          updatedAt: nowIso,
          lastActivityAt: nowIso,
        })
        bump(pre.outcome)
        continue
      }

      const priorForming = pre.priorEntry?.outcome === "forming"
        ? pre.priorEntry
        : thread.formingEntryId
          ? ledger.entries.find((e) => e.entryId === thread.formingEntryId)
          : undefined

      const evidencePath = await writeThreadEvidence({
        layout: args.layout,
        thread,
        nowIso,
        ...(priorForming?.formingNote ? { formingNote: priorForming.formingNote } : {}),
        ...(pre.extendsIncidentId
          && incidentsFile.incidents.find((i) => i.incidentId === pre.extendsIncidentId)?.title
          ? {
            extendsSummary: incidentsFile.incidents.find(
              (i) => i.incidentId === pre.extendsIncidentId,
            )!.title,
          }
          : {}),
      })

      pendingThreads.push({
        thread,
        evidencePath,
        ...(pre.extendsIncidentId ? { extendsIncidentId: pre.extendsIncidentId } : {}),
        ...(priorForming ? { priorForming } : {}),
      })
    }

    if (newestInChannel) {
      cursors = {
        ...cursors,
        discordChannelCursors: {
          ...cursors.discordChannelCursors,
          [channelId]: newestInChannel,
        },
        discordScanCheckpoint: undefined,
      }
      await args.store.saveCursors(cursors)
    }
  }

  if (pendingThreads.length === 0) {
    ledger = await applyFollowupBackfill(ledger)
    await args.store.saveSuggestions(ledger)
    await args.store.save(incidentsFile)
    await args.store.saveCursors({
      ...cursors,
      suggestionClassifierFailures: 0,
    })
    return { threadsSeen, outcomes, incidentsCreated, classifierFailed: false }
  }

  const evidenceIndexPath = join(args.layout.artifacts, `suggestion-batch-${nowIso.replace(/[:.]/gu, "-")}.json`)
  mkdirSync(args.layout.artifacts, { recursive: true, mode: 0o700 })
  await writeAtomicFileFsync(
    evidenceIndexPath,
    `${JSON.stringify({
      schema: 1,
      trust: "host-derived",
      threads: pendingThreads.map((p) => ({
        threadId: p.thread.threadId,
        evidencePath: p.evidencePath,
        messageIds: p.thread.messages.map((m) => m.id),
        ...(p.extendsIncidentId ? { extendsIncidentId: p.extendsIncidentId } : {}),
        ...(p.priorForming?.formingNote
          ? { priorFormingNote: p.priorForming.formingNote }
          : {}),
      })),
    }, null, 2)}\n`,
    0o600,
  )

  const classified = await runClassifier({
    repoRoot: args.repoRoot,
    evidenceIndexPath,
    model: ds.classifier_model,
  })

  if (!classified.ok) {
    const failures = (cursors.suggestionClassifierFailures ?? 0) + 1
    const exhausted = failures >= MAX_CLASSIFIER_FAILURES
    for (const pending of pendingThreads) {
      const outcome: SuggestionOutcome = exhausted
        ? "classifier-exhausted"
        : "classifier-failed"
      ledger = upsertLedgerEntry(ledger, {
        schema: 1,
        entryId: `sug-${pending.thread.contentFingerprint.slice(0, 12)}`,
        threadId: pending.thread.threadId,
        channelId: pending.thread.channelId,
        contentFingerprint: pending.thread.contentFingerprint,
        outcome,
        reason: classified.reason.slice(0, 500),
        humanMessageIds: [...pending.thread.humanMessageIds],
        allMessageIds: pending.thread.messages.map((m) => m.id),
        participantIds: [...pending.thread.participantIds],
        evidencePath: pending.evidencePath,
        formingRounds: pending.priorForming?.formingRounds ?? 0,
        createdAt: pending.priorForming?.createdAt ?? nowIso,
        updatedAt: nowIso,
        lastActivityAt: nowIso,
      })
      bump(outcome)
    }
    ledger = await applyFollowupBackfill(ledger)
    await args.store.saveSuggestions(ledger)
    await args.store.save(incidentsFile)
    await args.store.saveCursors({
      ...cursors,
      suggestionClassifierFailures: failures,
    })
    return { threadsSeen, outcomes, incidentsCreated, classifierFailed: true }
  }

  const allowedThreadIds = new Set(pendingThreads.map((p) => p.thread.threadId))
  const validated = validateClassifierBatch(classified.batch, allowedThreadIds)
  if (!validated.ok) {
    const failures = (cursors.suggestionClassifierFailures ?? 0) + 1
    const exhausted = failures >= MAX_CLASSIFIER_FAILURES
    for (const pending of pendingThreads) {
      const outcome: SuggestionOutcome = exhausted
        ? "classifier-exhausted"
        : "classifier-failed"
      ledger = upsertLedgerEntry(ledger, {
        schema: 1,
        entryId: `sug-${pending.thread.contentFingerprint.slice(0, 12)}`,
        threadId: pending.thread.threadId,
        channelId: pending.thread.channelId,
        contentFingerprint: pending.thread.contentFingerprint,
        outcome,
        reason: validated.reason.slice(0, 500),
        humanMessageIds: [...pending.thread.humanMessageIds],
        allMessageIds: pending.thread.messages.map((m) => m.id),
        participantIds: [...pending.thread.participantIds],
        evidencePath: pending.evidencePath,
        formingRounds: pending.priorForming?.formingRounds ?? 0,
        createdAt: pending.priorForming?.createdAt ?? nowIso,
        updatedAt: nowIso,
        lastActivityAt: nowIso,
      })
      bump(outcome)
    }
    ledger = await applyFollowupBackfill(ledger)
    await args.store.saveSuggestions(ledger)
    await args.store.save(incidentsFile)
    await args.store.saveCursors({
      ...cursors,
      suggestionClassifierFailures: failures,
    })
    return { threadsSeen, outcomes, incidentsCreated, classifierFailed: true }
  }

  const resultsById = new Map(
    validated.batch.threads.map((t) => [t.threadId, t]),
  )

  for (const pending of pendingThreads) {
    const result = resultsById.get(pending.thread.threadId)
    const applied = applyClassifierResult({
      pending,
      result,
      ledger,
      incidentsFile,
      nowIso,
      newThisScan,
      ds,
    })
    ledger = applied.ledger
    incidentsFile = applied.incidentsFile
    newThisScan = applied.newThisScan
    incidentsCreated += applied.incidentsCreated
    bump(applied.outcome)

    if (applied.outcome !== "forming") continue
    const replyToMessageId = followupReplyTargetId(pending.thread)
    if (!replyToMessageId) continue
    const followup = await maybePostSuggestionFollowup({
      client,
      ledger,
      entryId: suggestionEntryId(pending.thread, pending.priorForming),
      channelId: pending.thread.channelId,
      replyToMessageId,
      ...(result?.followupQuestion ? { question: result.followupQuestion } : {}),
      enabled: ds.followup_enabled,
      nowIso,
    })
    ledger = followup.ledger
    if (followup.posted) {
      // Persist at once so a crash cannot make the bot ask the same question twice
      await args.store.saveSuggestions(ledger)
      bump("followup-asked")
    }
  }

  ledger = await applyFollowupBackfill(ledger)
  await args.store.saveSuggestions(ledger)
  await args.store.save(incidentsFile)
  await args.store.saveCursors({
    ...cursors,
    suggestionClassifierFailures: 0,
  })

  return { threadsSeen, outcomes, incidentsCreated, classifierFailed: false }
}

function suggestionEntryId(
  thread: ConversationThread,
  priorForming?: SuggestionLedgerEntry,
): string {
  return priorForming?.entryId ?? `sug-${thread.contentFingerprint.slice(0, 12)}`
}

function applyClassifierResult(args: Readonly<{
  pending: {
    thread: ConversationThread
    evidencePath: string
    extendsIncidentId?: string
    priorForming?: SuggestionLedgerEntry
  }
  result: SuggestionClassifierThreadResult | undefined
  ledger: SuggestionLedgerFile
  incidentsFile: ReturnType<RemediationStore["load"]>
  nowIso: string
  newThisScan: number
  ds: {
    max_new_incidents_per_scan: number
    max_active_suggestion_incidents: number
    max_forming_rounds: number
    min_confidence: number
  }
}>): {
  ledger: SuggestionLedgerFile
  incidentsFile: ReturnType<RemediationStore["load"]>
  newThisScan: number
  incidentsCreated: number
  outcome: SuggestionOutcome
} {
  const { pending, result, nowIso, ds } = args
  let { ledger, incidentsFile, newThisScan } = args
  const entryId = suggestionEntryId(pending.thread, pending.priorForming)
  const baseEntry: SuggestionLedgerEntry = {
    schema: 1,
    entryId,
    threadId: pending.thread.threadId,
    channelId: pending.thread.channelId,
    contentFingerprint: pending.thread.contentFingerprint,
    outcome: "not-buildable",
    humanMessageIds: [...pending.thread.humanMessageIds],
    allMessageIds: pending.thread.messages.map((m) => m.id),
    participantIds: [...pending.thread.participantIds],
    evidencePath: pending.evidencePath,
    formingRounds: pending.priorForming?.formingRounds ?? 0,
    ...(pending.extendsIncidentId
      ? { extendsIncidentId: pending.extendsIncidentId }
      : {}),
    createdAt: pending.priorForming?.createdAt ?? nowIso,
    updatedAt: nowIso,
    lastActivityAt: nowIso,
  }

  if (!result) {
    ledger = upsertLedgerEntry(ledger, {
      ...baseEntry,
      outcome: "not-buildable",
      reason: "classifier-omitted",
    })
    return {
      ledger,
      incidentsFile,
      newThisScan,
      incidentsCreated: 0,
      outcome: "not-buildable",
    }
  }

  // Host allowlist message ids
  const knownIds = new Set(pending.thread.messages.map((m) => m.id))
  if (result.contributingMessageIds?.some((id) => !knownIds.has(id))) {
    ledger = upsertLedgerEntry(ledger, {
      ...baseEntry,
      outcome: "classifier-failed",
      reason: "unknown-message-id",
    })
    return {
      ledger,
      incidentsFile,
      newThisScan,
      incidentsCreated: 0,
      outcome: "classifier-failed",
    }
  }

  let verdict = result.verdict
  const confidence = result.confidence ?? 0
  if (verdict === "suggestion-formed" && confidence < ds.min_confidence) {
    verdict = "forming"
  }
  let contractReason: string | undefined
  if (verdict === "suggestion-formed") {
    const contract = checkFormedContract(result)
    if (!contract.ok) {
      contractReason = contract.reason
      if (contract.downgrade === "forming") {
        verdict = "forming"
      } else {
        ledger = upsertLedgerEntry(ledger, {
          ...baseEntry,
          outcome: "classifier-failed",
          reason: contract.reason,
        })
        return {
          ledger,
          incidentsFile,
          newThisScan,
          incidentsCreated: 0,
          outcome: "classifier-failed",
        }
      }
    }
  }

  if (verdict === "not-buildable") {
    ledger = upsertLedgerEntry(ledger, {
      ...baseEntry,
      outcome: "not-buildable",
      reason: "classifier-not-buildable",
    })
    return {
      ledger,
      incidentsFile,
      newThisScan,
      incidentsCreated: 0,
      outcome: "not-buildable",
    }
  }

  if (verdict === "forming") {
    const rounds = (pending.priorForming?.formingRounds ?? 0) + 1
    if (rounds > ds.max_forming_rounds) {
      ledger = upsertLedgerEntry(ledger, {
        ...baseEntry,
        outcome: "not-buildable",
        reason: "forming-rounds-exhausted",
        formingRounds: rounds,
        formingNote: result.formingNote
          ? sanitizeSecretLike(result.formingNote, 500)
          : undefined,
      })
      return {
        ledger,
        incidentsFile,
        newThisScan,
        incidentsCreated: 0,
        outcome: "not-buildable",
      }
    }
    ledger = upsertLedgerEntry(ledger, {
      ...baseEntry,
      outcome: "forming",
      formingRounds: rounds,
      formingNote: result.formingNote
        ? sanitizeSecretLike(result.formingNote, 500)
        : "forming",
      reason: contractReason ?? "awaiting-more-context",
    })
    return {
      ledger,
      incidentsFile,
      newThisScan,
      incidentsCreated: 0,
      outcome: "forming",
    }
  }

  // suggestion-formed
  if (!result.category || !result.summary) {
    ledger = upsertLedgerEntry(ledger, {
      ...baseEntry,
      outcome: "classifier-failed",
      reason: "missing-category-or-summary",
    })
    return {
      ledger,
      incidentsFile,
      newThisScan,
      incidentsCreated: 0,
      outcome: "classifier-failed",
    }
  }

  const summary = sanitizeSecretLike(result.summary, 500)
  const entry: SuggestionLedgerEntry = {
    ...baseEntry,
    outcome: "suggestion-formed",
    category: result.category,
    summary,
    confidence,
    symptom: result.symptom ? sanitizeSecretLike(result.symptom, 500) : undefined,
    intendedBehavior: result.intendedBehavior
      ? sanitizeSecretLike(result.intendedBehavior, 500)
      : undefined,
    acceptanceCriteria: result.acceptanceCriteria?.map((c) =>
      sanitizeSecretLike(c, 280),
    ),
    alternativesConsidered: result.alternativesConsidered?.map((a) =>
      sanitizeSecretLike(a, 200),
    ),
    recommendationRationale: result.recommendationRationale
      ? sanitizeSecretLike(result.recommendationRationale, 500)
      : undefined,
  }

  const activeSuggestion = incidentsFile.incidents.filter((i) =>
    i.origin === "discord-suggestion"
    && (ACTIVE_REMEDIATION_PHASES as Set<string>).has(i.phase),
  ).length
  const gate = hostWorthBuildingGate({
    category: result.category,
    summary,
    activeSuggestionIncidents: activeSuggestion,
    newThisScan,
    incidents: incidentsFile.incidents,
    ...(pending.extendsIncidentId
      ? { extendsIncidentId: pending.extendsIncidentId }
      : {}),
    maxNewPerScan: ds.max_new_incidents_per_scan,
    maxActive: ds.max_active_suggestion_incidents,
  })

  if (gate.outcome === "capacity") {
    ledger = upsertLedgerEntry(ledger, {
      ...entry,
      outcome: "queued-waiting",
      reason: gate.reason,
    })
    const queuedWaiting = [
      ...ledger.queuedWaiting.filter((q) => q.entryId !== entryId),
      { entryId, enqueuedAt: nowIso },
    ].slice(0, 200)
    ledger = { ...ledger, queuedWaiting }
    return {
      ledger,
      incidentsFile,
      newThisScan,
      incidentsCreated: 0,
      outcome: "queued-waiting",
    }
  }

  if (gate.outcome) {
    ledger = upsertLedgerEntry(ledger, {
      ...entry,
      outcome: gate.outcome,
      reason: gate.reason,
    })
    return {
      ledger,
      incidentsFile,
      newThisScan,
      incidentsCreated: 0,
      outcome: gate.outcome,
    }
  }

  // Create incident synchronously (no async in this helper path for ledger-only);
  // caller path uses createSuggestionIncident for waiting queue — inline here:
  const fingerprint = incidentSuggestionFingerprint(result.category, summary)
  const incidentId = shortIncidentId(fingerprint)
  const incident: RemediationIncident = {
    schema: 1,
    incidentId,
    fingerprint,
    phase: "triaged",
    createdAt: nowIso,
    updatedAt: nowIso,
    component: "discord-suggestion",
    errorClass: result.category,
    title: summary.slice(0, 280),
    severity: "info",
    origin: "discord-suggestion",
    suggestionThreadId: pending.thread.threadId,
    suggestionCategory: result.category,
    triageVerdict: "attention-now",
    triageReason: "discord-suggestion-formed",
    attemptCount: 0,
    originMoveRebuilds: 0,
    preReviewReviseCount: 0,
    evidencePaths: [pending.evidencePath],
    ...(pending.extendsIncidentId
      ? { extendsIncidentId: pending.extendsIncidentId }
      : {}),
    ...(entry.alternativesConsidered
      ? { alternativesConsidered: entry.alternativesConsidered }
      : {}),
    ...(entry.recommendationRationale
      ? { recommendationRationale: entry.recommendationRationale }
      : {}),
  }
  incidentsFile = upsertIncident(incidentsFile, incident)
  if (!incidentsFile.activeIncidentId) {
    incidentsFile = { ...incidentsFile, activeIncidentId: incidentId }
  }
  ledger = upsertLedgerEntry(ledger, {
    ...entry,
    outcome: "queued",
    incidentId,
    reason: "enqueued",
  })
  return {
    ledger,
    incidentsFile,
    newThisScan: newThisScan + 1,
    incidentsCreated: 1,
    outcome: "queued",
  }
}

async function createSuggestionIncident(args: Readonly<{
  store: RemediationStore
  layout: RemediationLayout
  entry: SuggestionLedgerEntry
  nowIso: string
  incidentsFile: ReturnType<RemediationStore["load"]>
}>): Promise<{
  ledger: SuggestionLedgerFile
  incidentsFile: ReturnType<RemediationStore["load"]>
}> {
  if (!args.entry.category || !args.entry.summary) {
    return {
      ledger: args.store.loadSuggestions(),
      incidentsFile: args.incidentsFile,
    }
  }
  const fingerprint = incidentSuggestionFingerprint(
    args.entry.category,
    args.entry.summary,
  )
  const incidentId = shortIncidentId(fingerprint)
  const incident: RemediationIncident = {
    schema: 1,
    incidentId,
    fingerprint,
    phase: "triaged",
    createdAt: args.nowIso,
    updatedAt: args.nowIso,
    component: "discord-suggestion",
    errorClass: args.entry.category,
    title: args.entry.summary.slice(0, 280),
    severity: "info",
    origin: "discord-suggestion",
    suggestionThreadId: args.entry.threadId,
    suggestionCategory: args.entry.category,
    triageVerdict: "attention-now",
    triageReason: "discord-suggestion-formed",
    attemptCount: 0,
    originMoveRebuilds: 0,
    preReviewReviseCount: 0,
    evidencePaths: args.entry.evidencePath ? [args.entry.evidencePath] : [],
    ...(args.entry.extendsIncidentId
      ? { extendsIncidentId: args.entry.extendsIncidentId }
      : {}),
    ...(args.entry.alternativesConsidered
      ? { alternativesConsidered: args.entry.alternativesConsidered }
      : {}),
    ...(args.entry.recommendationRationale
      ? { recommendationRationale: args.entry.recommendationRationale }
      : {}),
  }
  let incidentsFile = upsertIncident(args.incidentsFile, incident)
  if (!incidentsFile.activeIncidentId) {
    incidentsFile = { ...incidentsFile, activeIncidentId: incidentId }
  }
  let ledger = args.store.loadSuggestions()
  ledger = upsertLedgerEntry(ledger, {
    ...args.entry,
    outcome: "queued",
    incidentId,
    reason: "enqueued",
    updatedAt: args.nowIso,
  })
  ledger = {
    ...ledger,
    queuedWaiting: ledger.queuedWaiting.filter((q) => q.entryId !== args.entry.entryId),
  }
  return { ledger, incidentsFile }
}

export function listSuggestionLedger(
  store: RemediationStore,
): SuggestionLedgerFile {
  return store.loadSuggestions()
}

export function markSuggestionBuilt(
  ledger: SuggestionLedgerFile,
  incidentId: string,
  nowIso: string,
): SuggestionLedgerFile {
  const entry = ledger.entries.find((e) => e.incidentId === incidentId)
  if (!entry) return ledger
  return upsertLedgerEntry(ledger, {
    ...entry,
    outcome: "built",
    updatedAt: nowIso,
  })
}

export function markSuggestionNotViable(
  ledger: SuggestionLedgerFile,
  incidentId: string,
  reason: string,
  nowIso: string,
): SuggestionLedgerFile {
  const entry = ledger.entries.find((e) => e.incidentId === incidentId)
  if (!entry) return ledger
  return upsertLedgerEntry(ledger, {
    ...entry,
    outcome: "not-viable",
    reason: reason.slice(0, 500),
    updatedAt: nowIso,
  })
}

export function validateClassifierBatch(
  batch: SuggestionClassifierBatch,
  allowedThreadIds: ReadonlySet<string>,
): { ok: true; batch: SuggestionClassifierBatch } | { ok: false; reason: string } {
  for (const thread of batch.threads) {
    if (!allowedThreadIds.has(thread.threadId)) {
      return { ok: false, reason: `unknown-thread:${thread.threadId}` }
    }
  }
  return { ok: true, batch }
}

export type { RemediationCursorsFile }

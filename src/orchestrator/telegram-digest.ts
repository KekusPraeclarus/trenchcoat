/**
 * Host-only daily Telegram narrative digest (04:00 Europe/London).
 * Immutable per-London-date ledger; Telegram-only narrative.digest events.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import {
  RouterEventSchema,
  type RouterEvent,
} from "../contracts/schemas.js"
import {
  telegramDigestPath,
  type ArchiveLayout,
  runArchiveDir,
  writeJsonRecordFsync,
} from "../lib/archive.js"
import { sha256Json } from "../lib/canonical-json.js"
import { Outbox } from "../lib/outbox.js"
import {
  runTelegramDailyDigestDistiller,
  renderDailyDigestCompactFallback,
  renderDailyDigestMarkdown,
  normalizeDigestSectionBody,
  selectDigestNarratives,
  type TopicNarrativeSnapshot,
} from "./distill-session.js"
import {
  narrativeLogPath,
  pruneNarrativeLogInMemory,
  type NarrativeLogEntry,
} from "./narrative-log.js"
import { buildNarrativeDigestRouterEvent } from "./router.js"

export const LONDON_TZ = "Europe/London"
export const DIGEST_HOUR = 4

export type TelegramDigestOutcome =
  | "prepared"
  | "no-active-narratives"
  | "no-window-developments"

export type TelegramDigestRecord = Readonly<{
  schema: 1
  londonDate: string
  windowStart: string
  windowEnd: string
  activeNarrativeSlugs: readonly string[]
  sourceEventIds: readonly string[]
  inputHash: `sha256:${string}`
  outcome: TelegramDigestOutcome
  renderMethod?: "distilled" | "fallback"
  event?: RouterEvent
  preparedAt: string
}>

export type TelegramDigestReport = Readonly<{
  schema: 1
  runId: string
  londonDate: string
  outcome: TelegramDigestOutcome
  reused: boolean
  renderMethod?: "distilled" | "fallback"
  eventId?: string
  activeCount: number
  sourceCount: number
}>

function parseIso(value: string): number {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : Number.NaN
}

function londonParts(instant: Date): Readonly<{
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LONDON_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant)
  const read = (type: string): number => {
    const value = parts.find((part) => part.type === type)?.value
    return Number(value)
  }
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  }
}

export function londonDateKey(instant: Date): string {
  const parts = londonParts(instant)
  const month = String(parts.month).padStart(2, "0")
  const day = String(parts.day).padStart(2, "0")
  return `${parts.year}-${month}-${day}`
}

/** UTC ms for a London wall-clock date/time (handles BST/GMT). */
export function londonLocalToUtcMs(
  londonDate: string,
  hour: number,
  minute = 0,
  second = 0,
): number {
  const [yearRaw, monthRaw, dayRaw] = londonDate.split("-")
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  const day = Number(dayRaw)
  let utc = Date.UTC(year, month - 1, day, hour, minute, second)
  for (let i = 0; i < 4; i += 1) {
    const parts = londonParts(new Date(utc))
    const asUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    )
    const target = Date.UTC(year, month - 1, day, hour, minute, second)
    const delta = target - asUtc
    if (delta === 0) break
    utc += delta
  }
  return utc
}

export function previousLondonDate(londonDate: string): string {
  const midnight = londonLocalToUtcMs(londonDate, 0, 0, 0)
  return londonDateKey(new Date(midnight - 1))
}

/** Calendar date of activity summarized by a digest (prior 04:00→04:00 London window). */
export function digestActivityLondonDate(londonDate: string): string {
  return previousLondonDate(londonDate)
}

/**
 * Latest London calendar date whose 04:00 cutoff is not after `now`.
 * A late timer only produces this latest missed day.
 */
export function resolveDigestLondonDate(now: Date): string {
  const today = londonDateKey(now)
  const todayCutoff = londonLocalToUtcMs(today, DIGEST_HOUR, 0, 0)
  if (now.getTime() >= todayCutoff) return today
  return previousLondonDate(today)
}

export function digestWindowForLondonDate(londonDate: string): Readonly<{
  windowStart: string
  windowEnd: string
}> {
  const prev = previousLondonDate(londonDate)
  const startMs = londonLocalToUtcMs(prev, DIGEST_HOUR, 0, 0)
  const endMs = londonLocalToUtcMs(londonDate, DIGEST_HOUR, 0, 0)
  return {
    windowStart: new Date(startMs).toISOString(),
    windowEnd: new Date(endMs).toISOString(),
  }
}

function toSnapshot(entry: NarrativeLogEntry): TopicNarrativeSnapshot {
  return {
    slug: entry.slug,
    stage: entry.stage,
    tickers: entry.tickers ?? [],
    lastSeen: entry.lastSeen,
  }
}

export function loadActiveNarratives(args: Readonly<{
  agentRoot: string
  nowIso: string
  retentionDays: number
}>): NarrativeLogEntry[] {
  const path = narrativeLogPath(args.agentRoot)
  const raw = existsSync(path) ? readFileSync(path, "utf8") : ""
  return pruneNarrativeLogInMemory(raw, args.nowIso, args.retentionDays).entries
}

export type DigestSourceEvent = Readonly<{
  eventId: string
  subject: string
  text: string
  deliveredAt: string
}>

/**
 * Host-staged intraday finding.broadcast events with a Telegram payload whose
 * router-ingress receipt was accepted or duplicate within the window, selected
 * by receipt deliveredAt (not event.occurredAt).
 */
export function extractDigestSourceEvents(args: Readonly<{
  layout: ArchiveLayout
  windowStart: string
  windowEnd: string
}>): DigestSourceEvent[] {
  const startMs = parseIso(args.windowStart)
  const endMs = parseIso(args.windowEnd)
  const outboxRoot = args.layout.routerOutbox
  if (!existsSync(outboxRoot)) return []
  const out: DigestSourceEvent[] = []

  for (const runDir of readdirSync(outboxRoot)) {
    const dir = join(outboxRoot, runDir)
    let files: string[]
    try {
      files = readdirSync(dir).filter((name) => name.endsWith(".json"))
    } catch {
      continue
    }
    const receiptPath = join(runArchiveDir(args.layout, runDir), "delivery-receipts.json")
    const deliveredAtByEvent = new Map<string, string>()
    if (existsSync(receiptPath)) {
      try {
        const receipts = JSON.parse(readFileSync(receiptPath, "utf8")) as {
          receipts?: Array<{ eventId?: string; status?: string; deliveredAt?: string }>
        }
        for (const receipt of receipts.receipts ?? []) {
          if (
            receipt.eventId
            && receipt.deliveredAt
            && (receipt.status === "accepted" || receipt.status === "duplicate")
          ) {
            deliveredAtByEvent.set(receipt.eventId, receipt.deliveredAt)
          }
        }
      } catch {
        // ignore corrupt receipts
      }
    }

    for (const name of files) {
      try {
        const event = RouterEventSchema.parse(
          JSON.parse(readFileSync(join(dir, name), "utf8")),
        )
        if (event.type !== "finding.broadcast") continue
        const telegramText = event.channels?.telegram?.text
        if (!telegramText) continue
        const deliveredAt = deliveredAtByEvent.get(event.eventId)
        if (!deliveredAt) continue
        const ms = parseIso(deliveredAt)
        if (!(ms > startMs && ms <= endMs)) continue
        out.push({
          eventId: event.eventId,
          subject: (event.auditClaim?.subject ?? "").trim().toLowerCase(),
          text: telegramText,
          deliveredAt,
        })
      } catch {
        // skip malformed
      }
    }
  }

  return out.sort((a, b) => a.deliveredAt.localeCompare(b.deliveredAt))
}

function developmentsBySlug(
  active: readonly NarrativeLogEntry[],
  sources: readonly DigestSourceEvent[],
): Record<string, string> {
  const activeSlugs = new Set(active.map((entry) => entry.slug))
  const buckets = new Map<string, string[]>()
  for (const source of sources) {
    if (!activeSlugs.has(source.subject)) continue
    const list = buckets.get(source.subject) ?? []
    list.push(source.text)
    buckets.set(source.subject, list)
  }
  const out: Record<string, string> = {}
  for (const entry of active) {
    const paragraphs = (buckets.get(entry.slug) ?? [])
      .map((text) => normalizeDigestSectionBody(text))
      .filter((text) => text.length > 0)
    out[entry.slug] = paragraphs.join(" ")
  }
  return out
}

function loadDigestRecord(layout: ArchiveLayout, londonDate: string): TelegramDigestRecord | undefined {
  const path = telegramDigestPath(layout, londonDate)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as TelegramDigestRecord
    if (parsed.schema !== 1 || parsed.londonDate !== londonDate) return undefined
    return parsed
  } catch {
    return undefined
  }
}

async function persistDigestRecord(
  layout: ArchiveLayout,
  record: TelegramDigestRecord,
): Promise<void> {
  await writeJsonRecordFsync(
    telegramDigestPath(layout, record.londonDate),
    record as never,
  )
}

export async function prepareTelegramDigest(args: Readonly<{
  agentRoot: string
  layout: ArchiveLayout
  runId: string
  nowIso: string
  retentionDays: number
  enabled: boolean
  dailyCap: number
  usedToday: number
  runSession?: (args: Readonly<{ prompt: string; message: string }>) => Promise<string>
}>): Promise<Readonly<{
  record: TelegramDigestRecord
  report: TelegramDigestReport
  usedToday: number
}>> {
  const now = new Date(args.nowIso)
  const londonDate = resolveDigestLondonDate(now)
  const activityLondonDate = digestActivityLondonDate(londonDate)
  const existing = loadDigestRecord(args.layout, londonDate)
  if (existing) {
    return {
      record: existing,
      usedToday: args.usedToday,
      report: {
        schema: 1,
        runId: args.runId,
        londonDate,
        outcome: existing.outcome,
        reused: true,
        ...(existing.renderMethod ? { renderMethod: existing.renderMethod } : {}),
        ...(existing.event ? { eventId: existing.event.eventId } : {}),
        activeCount: existing.activeNarrativeSlugs.length,
        sourceCount: existing.sourceEventIds.length,
      },
    }
  }

  const { windowStart, windowEnd } = digestWindowForLondonDate(londonDate)
  const active = loadActiveNarratives({
    agentRoot: args.agentRoot,
    nowIso: args.nowIso,
    retentionDays: args.retentionDays,
  })
  const sources = extractDigestSourceEvents({
    layout: args.layout,
    windowStart,
    windowEnd,
  })
  const activeSlugs = active.map((entry) => entry.slug).sort((a, b) => a.localeCompare(b))
  const sourceEventIds = sources.map((source) => source.eventId)
  const snapshots = active.map(toSnapshot)
  const developments = developmentsBySlug(active, sources)
  const inputHash = sha256Json({
    londonDate,
    windowStart,
    windowEnd,
    active: snapshots.map((entry) => ({
      slug: entry.slug,
      stage: entry.stage,
      tickers: [...entry.tickers],
      lastSeen: entry.lastSeen,
    })),
    developments,
  })

  if (active.length === 0) {
    const record: TelegramDigestRecord = {
      schema: 1,
      londonDate,
      windowStart,
      windowEnd,
      activeNarrativeSlugs: [],
      sourceEventIds,
      inputHash,
      outcome: "no-active-narratives",
      preparedAt: args.nowIso,
    }
    await persistDigestRecord(args.layout, record)
    return {
      record,
      usedToday: args.usedToday,
      report: {
        schema: 1,
        runId: args.runId,
        londonDate,
        outcome: "no-active-narratives",
        reused: false,
        activeCount: 0,
        sourceCount: sources.length,
      },
    }
  }

  const interesting = selectDigestNarratives(snapshots, developments)
  if (interesting.length === 0) {
    const record: TelegramDigestRecord = {
      schema: 1,
      londonDate,
      windowStart,
      windowEnd,
      activeNarrativeSlugs: activeSlugs,
      sourceEventIds,
      inputHash,
      outcome: "no-window-developments",
      preparedAt: args.nowIso,
    }
    await persistDigestRecord(args.layout, record)
    return {
      record,
      usedToday: args.usedToday,
      report: {
        schema: 1,
        runId: args.runId,
        londonDate,
        outcome: "no-window-developments",
        reused: false,
        activeCount: active.length,
        sourceCount: sources.length,
      },
    }
  }

  let usedToday = args.usedToday
  let renderMethod: "distilled" | "fallback" = "fallback"
  let text: string | null = null

  const distilled = await runTelegramDailyDigestDistiller({
    packet: {
      londonDate,
      windowStart,
      windowEnd,
      activeNarratives: interesting,
      developmentsBySlug: developments,
    },
    titleLondonDate: activityLondonDate,
    dailyCap: args.dailyCap,
    usedToday,
    enabled: args.enabled,
    ...(args.runSession ? { runSession: args.runSession } : {}),
  })
  usedToday = distilled.used

  if (!distilled.usedFallback && distilled.sections.length > 0) {
    const sectionsBySlug = Object.fromEntries(
      distilled.sections.map((section) => [section.slug, section.body]),
    )
    text = renderDailyDigestMarkdown({
      londonDate: activityLondonDate,
      narratives: interesting,
      sectionsBySlug,
    })
    renderMethod = "distilled"
  }

  if (text === null) {
    text = renderDailyDigestCompactFallback({
      londonDate: activityLondonDate,
      narratives: interesting,
      developmentsBySlug: developments,
    })
    renderMethod = "fallback"
  }

  if (text === null) {
    throw new Error("telegram-digest prepared text missing despite window developments")
  }

  const event = buildNarrativeDigestRouterEvent({
    runId: args.runId,
    occurredAt: windowEnd,
    text,
    londonDate,
    windowStart,
    windowEnd,
    activeNarrativeSlugs: activeSlugs,
    sourceEventIds,
    inputHash,
  })

  const record: TelegramDigestRecord = {
    schema: 1,
    londonDate,
    windowStart,
    windowEnd,
    activeNarrativeSlugs: activeSlugs,
    sourceEventIds,
    inputHash,
    outcome: "prepared",
    renderMethod,
    event,
    preparedAt: args.nowIso,
  }
  await persistDigestRecord(args.layout, record)

  return {
    record,
    usedToday,
    report: {
      schema: 1,
      runId: args.runId,
      londonDate,
      outcome: "prepared",
      reused: false,
      renderMethod,
      eventId: event.eventId,
      activeCount: active.length,
      sourceCount: sources.length,
    },
  }
}

export async function stageTelegramDigestEvent(args: Readonly<{
  layout: ArchiveLayout
  runId: string
  record: TelegramDigestRecord
}>): Promise<void> {
  if (args.record.outcome !== "prepared" || !args.record.event) {
    throw new Error(`telegram-digest cannot stage outcome=${args.record.outcome}`)
  }
  const outbox = new Outbox(join(args.layout.routerOutbox, args.runId))
  await outbox.stage(args.record.event)
}

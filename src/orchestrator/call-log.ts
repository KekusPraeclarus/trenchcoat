import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { sha256Json } from "../lib/canonical-json.js"
import { type ArchiveLayout } from "../lib/archive.js"
import { extractCallEvents } from "../lib/call-events.js"
import { appendJsonl } from "./scorecard.js"
import {
  SnapshotEnvelopeSchema,
  SourceCallEventSchema,
  type SourceCallEvent,
} from "../contracts/schemas.js"
import { provenanceToSource } from "./rug-dock.js"

export function sourceCallLogPath(layout: ArchiveLayout): string {
  return join(layout.root, "source-call-log.jsonl")
}

/**
 * Provenance strings carry '@' and ':' which SafeId forbids, and ':' would break the
 * sourceId:token subjectId split. Prefer lifecycle-compatible ids (x_handle) from
 * provenanceToSource; fall back to a colon-free SafeId for unknown platforms.
 */
export function toSafeSourceId(provenance: string): string {
  const parts = provenance.split(":")
  if (parts.length >= 2) {
    const mapped = provenanceToSource(`${parts[0]}:${parts[1]}`)
    if (mapped) return mapped.sourceId
  }
  const cleaned = provenance
    .replace(/@/gu, "")
    .replace(/:/gu, ".")
    .replace(/[^A-Za-z0-9._-]/gu, "-")
    .replace(/^[^A-Za-z0-9]+/u, "")
  const bounded = (cleaned || "source").slice(0, 80)
  return /^[A-Za-z0-9]/u.test(bounded) ? bounded : `s${bounded}`.slice(0, 80)
}

export function sourceCallEventId(fields: Readonly<{
  sourceId: string
  rawAddress: string
  mentionedAt: string
  provenance: string
}>): string {
  const digest = sha256Json({ ...fields, parserVersion: 1 }).slice("sha256:".length, "sha256:".length + 40)
  return `sc_${digest}`
}

export function readExistingSourceCallEventIds(path: string): Set<string> {
  const ids = new Set<string>()
  if (!existsSync(path)) return ids
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      const parsed = SourceCallEventSchema.safeParse(JSON.parse(line))
      if (parsed.success) ids.add(parsed.data.eventId)
    } catch {
      continue
    }
  }
  return ids
}

export type CallLogItemInput = Readonly<{
  provenance: string
  text: string
  ts: string
  clusterId?: string
}>

export type AppendCallEventsReport = Readonly<{
  eventsExtracted: number
  appended: number
  skipped: number
  events: readonly SourceCallEvent[]
}>

/** X-post provenance only. FOMO profile swaps are entry evidence, not shill calls. */
export function isXPostProvenance(provenance: string): boolean {
  return provenance.startsWith("twitter:@") || provenance.startsWith("x:@")
}

export function isFomoProfileProvenance(provenance: string): boolean {
  return provenance.startsWith("fomo-profile:@")
}

export function xPostCallKey(args: Readonly<{
  sourceId: string
  rawAddress: string
  mentionedAt: string
}>): string {
  return `${args.sourceId}|${args.rawAddress.toLowerCase()}|${args.mentionedAt}`
}

/** Idempotent append of bullish CA call events from snapshot-shaped items. */
export async function appendSourceCallEventsFromItems(
  layout: ArchiveLayout,
  items: readonly CallLogItemInput[],
  opts?: Readonly<{ sourceIdOverride?: string }>,
): Promise<AppendCallEventsReport> {
  const logPath = sourceCallLogPath(layout)
  const existing = readExistingSourceCallEventIds(logPath)
  const appendedThisRun = new Set<string>()
  const events: SourceCallEvent[] = []
  let eventsExtracted = 0
  let appended = 0
  let skipped = 0

  for (const item of items) {
    if (!isXPostProvenance(item.provenance)) continue
    if (item.text.includes("purpose=fomo-profile-call")) continue
    const rawItemHash = sha256Json(item as never)
    const sourceId = opts?.sourceIdOverride ?? toSafeSourceId(item.provenance)
    const calls = extractCallEvents({
      sourceId,
      provenance: item.provenance,
      text: item.text,
      mentionedAt: item.ts,
    })
    for (const call of calls) {
      eventsExtracted += 1
      const idSource = opts?.sourceIdOverride ?? toSafeSourceId(call.provenance)
      const id = sourceCallEventId({
        sourceId: idSource,
        rawAddress: call.rawAddress,
        mentionedAt: call.mentionedAt,
        provenance: call.provenance,
      })
      if (existing.has(id) || appendedThisRun.has(id)) {
        skipped += 1
        continue
      }
      const event: SourceCallEvent = SourceCallEventSchema.parse({
        schema: 1,
        eventId: id,
        sourceId: idSource,
        provenance: call.provenance,
        rawAddress: call.rawAddress,
        chainHint: call.chainHint,
        mentionedAt: call.mentionedAt,
        parserVersion: 1,
        rawItemHash,
        ...(item.clusterId !== undefined ? { clusterId: item.clusterId } : {}),
      })
      await appendJsonl(logPath, event)
      appendedThisRun.add(id)
      events.push(event)
      appended += 1
    }
  }

  return { eventsExtracted, appended, skipped, events }
}

export type CallLogAppendReport = Readonly<{
  runId: string
  filesScanned: number
  eventsExtracted: number
  appended: number
  skipped: number
}>

/**
 * Deterministically derive bullish source-call events from a run's archived inbox
 * (INV-S12: only the pre-session archive copy, never the mutable workspace) and append
 * new ones to the append-only source-call log. Idempotent by eventId, so a resumed or
 * replayed run never double-counts a call.
 */
export async function appendSourceCallEventsFromArchiveInbox(
  layout: ArchiveLayout,
  runId: string,
  _agentRoot?: string,
): Promise<CallLogAppendReport> {
  const inboxDir = join(layout.runs, runId, "inbox")
  let filesScanned = 0
  let eventsExtracted = 0
  let appended = 0
  let skipped = 0

  if (!existsSync(inboxDir)) {
    return { runId, filesScanned, eventsExtracted, appended, skipped }
  }

  const items: CallLogItemInput[] = []
  for (const name of readdirSync(inboxDir).sort()) {
    if (!name.endsWith(".json")) continue
    let parsed
    try {
      parsed = SnapshotEnvelopeSchema.safeParse(
        JSON.parse(readFileSync(join(inboxDir, name), "utf8")),
      )
    } catch {
      continue
    }
    if (!parsed.success) continue
    filesScanned += 1

    for (const item of parsed.data.items) {
      items.push({
        provenance: item.provenance,
        text: item.text,
        ts: item.ts,
        ...(item.clusterId !== undefined ? { clusterId: item.clusterId } : {}),
      })
    }
  }

  const report = await appendSourceCallEventsFromItems(layout, items)
  return {
    runId,
    filesScanned,
    eventsExtracted: report.eventsExtracted,
    appended: report.appended,
    skipped: report.skipped,
  }
}

export function readSourceCallLog(layout: ArchiveLayout): SourceCallEvent[] {
  const path = sourceCallLogPath(layout)
  if (!existsSync(path)) return []
  const out: SourceCallEvent[] = []
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue
    const parsed = SourceCallEventSchema.safeParse(JSON.parse(line))
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

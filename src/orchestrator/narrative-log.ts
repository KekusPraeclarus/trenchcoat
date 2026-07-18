import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { writeAtomicFileFsync } from "../lib/fs-atomic.js"
import { runArchiveDir, writeJsonRecordFsync, type ArchiveLayout } from "../lib/archive.js"

export const NarrativeLogEntrySchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(64),
  title: z.string().min(1).max(128),
  firstSeen: z.string().datetime(),
  lastSeen: z.string().datetime(),
  evidence: z.array(z.string().min(1).max(256)).max(32),
  stage: z.enum(["emerging", "peaking", "fading"]),
  tickers: z.array(z.string().min(1).max(32)).max(8).optional(),
})
export type NarrativeLogEntry = z.infer<typeof NarrativeLogEntrySchema>

export type NarrativeLogPruneReport = Readonly<{
  schema: 1
  runId: string
  prunedAt: string
  retentionDays: number
  kept: number
  purged: number
  malformed: number
  path: string
}>

export function narrativeLogPath(agentRoot: string): string {
  return join(agentRoot, "state", "narratives", "log.jsonl")
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

function isWithinRetention(lastSeenIso: string, nowMs: number, retentionDays: number): boolean {
  const lastSeenMs = Date.parse(lastSeenIso)
  if (!Number.isFinite(lastSeenMs)) return false
  return nowMs - lastSeenMs <= retentionDays * MS_PER_DAY
}

/**
 * Parse agent-written JSONL as untrusted input: drop malformed lines, purge entries
 * whose lastSeen is older than retentionDays, collapse duplicate slugs to the richest
 * survivor (latest lastSeen, earliest firstSeen), rewrite atomically.
 */
export function pruneNarrativeLogInMemory(
  raw: string,
  nowIso: string,
  retentionDays: number,
): Readonly<{
  entries: NarrativeLogEntry[]
  kept: number
  purged: number
  malformed: number
}> {
  const nowMs = Date.parse(nowIso)
  if (!Number.isFinite(nowMs)) {
    throw new Error(`invalid nowIso: ${nowIso}`)
  }
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error(`invalid retentionDays: ${retentionDays}`)
  }

  let malformed = 0
  let purged = 0
  const bySlug = new Map<string, NarrativeLogEntry>()

  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      malformed += 1
      continue
    }
    const result = NarrativeLogEntrySchema.safeParse(parsed)
    if (!result.success) {
      malformed += 1
      continue
    }
    const entry = result.data
    if (Date.parse(entry.firstSeen) > Date.parse(entry.lastSeen)) {
      malformed += 1
      continue
    }
    if (!isWithinRetention(entry.lastSeen, nowMs, retentionDays)) {
      purged += 1
      continue
    }
    const prior = bySlug.get(entry.slug)
    if (!prior) {
      bySlug.set(entry.slug, entry)
      continue
    }
    // Duplicate slug: keep earliest firstSeen + latest lastSeen/stage/evidence
    const merged: NarrativeLogEntry = {
      ...entry,
      firstSeen: Date.parse(prior.firstSeen) <= Date.parse(entry.firstSeen)
        ? prior.firstSeen
        : entry.firstSeen,
      lastSeen: Date.parse(prior.lastSeen) >= Date.parse(entry.lastSeen)
        ? prior.lastSeen
        : entry.lastSeen,
      stage: Date.parse(prior.lastSeen) >= Date.parse(entry.lastSeen)
        ? prior.stage
        : entry.stage,
      evidence: Date.parse(prior.lastSeen) >= Date.parse(entry.lastSeen)
        ? prior.evidence
        : entry.evidence,
      title: Date.parse(prior.lastSeen) >= Date.parse(entry.lastSeen)
        ? prior.title
        : entry.title,
      ...(Date.parse(prior.lastSeen) >= Date.parse(entry.lastSeen)
        ? prior.tickers ? { tickers: prior.tickers } : {}
        : entry.tickers ? { tickers: entry.tickers } : {}),
    }
    bySlug.set(entry.slug, merged)
  }

  const entries = [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug))
  return { entries, kept: entries.length, purged, malformed }
}

function serializeLog(entries: readonly NarrativeLogEntry[]): string {
  if (entries.length === 0) return ""
  return `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`
}

export function narrativeProposalsPath(agentRoot: string, runId: string): string {
  return join(agentRoot, "reports", runId, "narrative-proposals.jsonl")
}

/**
 * Host-merge agent narrative proposals into state/narratives/log.jsonl.
 * Proposal file is untrusted: malformed lines are dropped. Existing log entries
 * survive unless a valid proposal updates the same slug.
 */
export async function mergeNarrativeProposals(args: Readonly<{
  agentRoot: string
  runId: string
  nowIso: string
}>): Promise<Readonly<{
  merged: number
  malformed: number
  path: string
}>> {
  const proposalPath = narrativeProposalsPath(args.agentRoot, args.runId)
  const logPath = narrativeLogPath(args.agentRoot)
  const existingRaw = existsSync(logPath) ? readFileSync(logPath, "utf8") : ""
  const proposalRaw = existsSync(proposalPath) ? readFileSync(proposalPath, "utf8") : ""
  // Merge by feeding existing + proposals through the same prune/collapse path with
  // a long retention so we only schema-filter and dedupe here; age prune is separate.
  const combined = [existingRaw, proposalRaw].filter((s) => s.trim().length > 0).join("\n")
  const { entries, malformed } = pruneNarrativeLogInMemory(combined, args.nowIso, 3650)
  await writeAtomicFileFsync(logPath, serializeLog(entries))
  const proposalCount = proposalRaw.split("\n").filter((l) => l.trim().length > 0).length
  return {
    merged: Math.min(proposalCount, entries.length),
    malformed,
    path: "state/narratives/log.jsonl",
  }
}

/**
 * Host prune of the narrative log. Creates an empty file when missing so the next
 * agent session has a stable path. Archives a receipt under the run directory when
 * layout is provided.
 */
export async function pruneNarrativeLog(args: Readonly<{
  agentRoot: string
  runId: string
  nowIso: string
  retentionDays: number
  layout?: ArchiveLayout
}>): Promise<NarrativeLogPruneReport> {
  const path = narrativeLogPath(args.agentRoot)
  const raw = existsSync(path) ? readFileSync(path, "utf8") : ""
  const { entries, kept, purged, malformed } = pruneNarrativeLogInMemory(
    raw,
    args.nowIso,
    args.retentionDays,
  )
  await writeAtomicFileFsync(path, serializeLog(entries))

  const report: NarrativeLogPruneReport = {
    schema: 1,
    runId: args.runId,
    prunedAt: args.nowIso,
    retentionDays: args.retentionDays,
    kept,
    purged,
    malformed,
    path: "state/narratives/log.jsonl",
  }

  if (args.layout) {
    await writeJsonRecordFsync(
      join(runArchiveDir(args.layout, args.runId), "narrative-log-prune.json"),
      report as never,
    )
  }

  return report
}

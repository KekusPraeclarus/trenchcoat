/**
 * 48h host cache for broadcast worthiness verdicts (claimHash + subject).
 * Stages/rejects without a new LLM when the claim is unchanged.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { writeAtomicFileFsync } from "../lib/fs-atomic.js"
import type { AuditClaim } from "../contracts/schemas.js"
import { claimHash, WORTHINESS_REASON_MAX } from "./broadcast-worthiness.js"
import { loadMarketClaimIndex } from "./market-claims.js"
import {
  narrativeLogPath,
  pruneNarrativeLogInMemory,
  type NarrativeLogEntry,
} from "./narrative-log.js"

export const WORTHINESS_CACHE_SCHEMA = 1
export const WORTHINESS_CACHE_MAX = 2_000
export const WORTHINESS_CACHE_TTL_MS = 48 * 3_600_000

export const WorthinessCacheEntrySchema = z.object({
  subject: z.string().min(1).max(256),
  claimHash: z.string().min(1).max(128),
  worth: z.boolean(),
  reason: z.string().min(1).max(WORTHINESS_REASON_MAX),
  decidedAt: z.string().min(1).max(64),
  expiresAt: z.string().min(1).max(64),
})
export type WorthinessCacheEntry = z.infer<typeof WorthinessCacheEntrySchema>

export const WorthinessCacheSchema = z.object({
  schema: z.literal(WORTHINESS_CACHE_SCHEMA),
  entries: z.array(WorthinessCacheEntrySchema).max(WORTHINESS_CACHE_MAX),
})
export type WorthinessCache = z.infer<typeof WorthinessCacheSchema>

export function worthinessCachePath(agentRoot: string): string {
  return join(agentRoot, "state", "broadcast-worthiness-cache.json")
}

export function emptyWorthinessCache(): WorthinessCache {
  return { schema: WORTHINESS_CACHE_SCHEMA, entries: [] }
}

export { claimHash }

/** Claim types whose hash does not name the catalyst. Do not reuse a verdict. */
const OPEN_CATALYST_CLAIM_TYPES = new Set<AuditClaim["type"]>([
  "narrative-emergence",
  "narrative-fade",
  "narrative-development",
  "rotation",
  "sentiment-collapse",
])

/** True when `{subject, claimHash}` uniquely identifies this catalyst. */
export function worthinessCacheApplies(claim: AuditClaim): boolean {
  return !OPEN_CATALYST_CLAIM_TYPES.has(claim.type)
}

function parseIso(iso: string): number {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : Number.NaN
}

function clipReason(value: string): string {
  const trimmed = value.trim().replace(/\s+/gu, " ")
  if ([...trimmed].length <= WORTHINESS_REASON_MAX) return trimmed
  return [...trimmed].slice(0, WORTHINESS_REASON_MAX).join("")
}

/** Load pruned narrative log entries (host helper path). */
export function readNarrativeLogEntries(
  agentRoot: string,
  nowIso: string,
  retentionDays = 365,
): NarrativeLogEntry[] {
  const path = narrativeLogPath(agentRoot)
  if (!existsSync(path)) return []
  try {
    return pruneNarrativeLogInMemory(
      readFileSync(path, "utf8"),
      nowIso,
      retentionDays,
    ).entries
  } catch {
    return []
  }
}

/**
 * Subjects with a durable narrative stage transition after decidedAt windows.
 * Combines market-claim narrative-stage rows (priorStage set) with optional
 * before/after log delta from the current run.
 */
export function narrativeStageChangeSubjects(args: Readonly<{
  agentRoot: string
  narrativeLogBefore?: readonly NarrativeLogEntry[]
  narrativeLogAfter?: readonly NarrativeLogEntry[]
}>): Map<string, string> {
  const out = new Map<string, string>()

  const index = loadMarketClaimIndex(args.agentRoot)
  for (const claim of index.claims) {
    if (claim.kind !== "narrative-stage") continue
    if (!claim.priorStage) continue
    const subject = claim.subject.trim().toLowerCase()
    const prior = out.get(subject)
    if (!prior || claim.occurredAt > prior) out.set(subject, claim.occurredAt)
  }

  if (args.narrativeLogBefore && args.narrativeLogAfter) {
    const beforeBy = new Map(
      args.narrativeLogBefore.map((entry) => [entry.slug, entry]),
    )
    for (const entry of args.narrativeLogAfter) {
      const prior = beforeBy.get(entry.slug)
      if (!prior || prior.stage === entry.stage) continue
      const subject = entry.slug.trim().toLowerCase()
      const priorAt = out.get(subject)
      if (!priorAt || entry.lastSeen > priorAt) out.set(subject, entry.lastSeen)
    }
  }

  return out
}

/**
 * Drop expired entries and narrative-type verdicts whose subject had a stage
 * change after decidedAt. claimHash encodes type — entries are dropped by
 * subject on stage change (conservative for any claim on that narrative slug).
 */
export function pruneWorthinessCache(
  cache: WorthinessCache,
  args: Readonly<{
    nowIso: string
    stageChangedAtBySubject?: ReadonlyMap<string, string>
  }>,
): WorthinessCache {
  const nowMs = parseIso(args.nowIso)
  const stageMap = args.stageChangedAtBySubject
  const kept: WorthinessCacheEntry[] = []
  for (const entry of cache.entries) {
    const expiresMs = parseIso(entry.expiresAt)
    if (Number.isFinite(nowMs) && Number.isFinite(expiresMs) && expiresMs <= nowMs) {
      continue
    }
    if (stageMap) {
      const changedAt = stageMap.get(entry.subject.trim().toLowerCase())
      if (changedAt !== undefined) {
        const decidedMs = parseIso(entry.decidedAt)
        const changedMs = parseIso(changedAt)
        if (
          Number.isFinite(decidedMs)
          && Number.isFinite(changedMs)
          && changedMs > decidedMs
        ) {
          // Stage change after decide — drop entries for that narrative subject
          continue
        }
      }
    }
    kept.push(entry)
  }
  return { schema: WORTHINESS_CACHE_SCHEMA, entries: kept.slice(0, WORTHINESS_CACHE_MAX) }
}

export function loadWorthinessCache(
  agentRoot: string,
  args: Readonly<{
    nowIso: string
    narrativeLogBefore?: readonly NarrativeLogEntry[]
    narrativeLogAfter?: readonly NarrativeLogEntry[]
  }>,
): WorthinessCache {
  const path = worthinessCachePath(agentRoot)
  let cache = emptyWorthinessCache()
  if (existsSync(path)) {
    try {
      cache = WorthinessCacheSchema.parse(JSON.parse(readFileSync(path, "utf8")))
    } catch {
      cache = emptyWorthinessCache()
    }
  }

  // Touch narrative log via host helper so stage invalidation can compare later.
  void readNarrativeLogEntries(agentRoot, args.nowIso)

  const stageChangedAtBySubject = narrativeStageChangeSubjects({
    agentRoot,
    ...(args.narrativeLogBefore ? { narrativeLogBefore: args.narrativeLogBefore } : {}),
    ...(args.narrativeLogAfter ? { narrativeLogAfter: args.narrativeLogAfter } : {}),
  })

  return pruneWorthinessCache(cache, {
    nowIso: args.nowIso,
    stageChangedAtBySubject,
  })
}

export async function saveWorthinessCache(
  agentRoot: string,
  cache: WorthinessCache,
): Promise<void> {
  WorthinessCacheSchema.parse(cache)
  await writeAtomicFileFsync(
    worthinessCachePath(agentRoot),
    `${JSON.stringify(cache, null, 2)}\n`,
  )
}

export function lookupWorthinessCache(
  cache: WorthinessCache,
  args: Readonly<{ subject: string; claimHash: string; nowIso: string }>,
): WorthinessCacheEntry | undefined {
  const subject = args.subject.trim().toLowerCase()
  const nowMs = parseIso(args.nowIso)
  return cache.entries.find((entry) => {
    if (entry.subject.trim().toLowerCase() !== subject) return false
    if (entry.claimHash !== args.claimHash) return false
    const expiresMs = parseIso(entry.expiresAt)
    if (Number.isFinite(nowMs) && Number.isFinite(expiresMs) && expiresMs <= nowMs) {
      return false
    }
    return true
  })
}

export function upsertWorthinessCache(
  cache: WorthinessCache,
  args: Readonly<{
    auditClaim: AuditClaim
    worth: boolean
    reason: string
    decidedAt: string
  }>,
): WorthinessCache {
  const subject = args.auditClaim.subject.trim().toLowerCase()
  const hash = claimHash(args.auditClaim)
  const decidedMs = parseIso(args.decidedAt)
  const expiresAt = Number.isFinite(decidedMs)
    ? new Date(decidedMs + WORTHINESS_CACHE_TTL_MS).toISOString()
    : args.decidedAt
  const entry: WorthinessCacheEntry = {
    subject,
    claimHash: hash,
    worth: args.worth,
    reason: clipReason(args.reason),
    decidedAt: args.decidedAt,
    expiresAt,
  }
  WorthinessCacheEntrySchema.parse(entry)
  const others = cache.entries.filter(
    (e) => !(e.subject.trim().toLowerCase() === subject && e.claimHash === hash),
  )
  return {
    schema: WORTHINESS_CACHE_SCHEMA,
    entries: [entry, ...others].slice(0, WORTHINESS_CACHE_MAX),
  }
}

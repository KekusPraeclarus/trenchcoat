import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { writeAtomicFileFsync } from "../lib/fs-atomic.js"
import { runArchiveDir, writeJsonRecordFsync, type ArchiveLayout } from "../lib/archive.js"
import {
  effectiveFraming,
  isMatureFraming,
  NarrativeFramingSchema,
  type NarrativeFraming,
} from "../lib/narrative-framing.js"
import { StateStore } from "../lib/state.js"
import { creditNarrativeContribution } from "../sources/narrative-lifecycle.js"
import { normalizeHandle } from "../sources/lifecycle.js"

const HandleSchema = z.string().regex(/^[A-Za-z0-9_]{1,15}$/u)

export {
  effectiveFraming,
  isMatureFraming,
  NarrativeFramingSchema,
  type NarrativeFraming,
} from "../lib/narrative-framing.js"

const ROTATION_WORD = /\brotation\b/iu

function framingFieldsValid(
  entry: Readonly<{
    title: string
    firstSeen: string
    lastSeen: string
    framing?: NarrativeFraming | undefined
    framingMaturedAt?: string | undefined
    framingEvidence?: readonly string[] | undefined
  }>,
): boolean {
  const framing = effectiveFraming(entry)
  if (!isMatureFraming(framing)) {
    if (entry.framingMaturedAt !== undefined || entry.framingEvidence !== undefined) {
      return false
    }
    // Explicit rotation must also omit maturity fields (already checked); title may contain rotation
    return true
  }
  if (!entry.framingMaturedAt || !entry.framingEvidence || entry.framingEvidence.length < 1) {
    return false
  }
  const maturedMs = Date.parse(entry.framingMaturedAt)
  const firstMs = Date.parse(entry.firstSeen)
  const lastMs = Date.parse(entry.lastSeen)
  if (!Number.isFinite(maturedMs) || maturedMs < firstMs || maturedMs > lastMs) {
    return false
  }
  if (ROTATION_WORD.test(entry.title)) return false
  return true
}

function titleOkForMature(title: string): boolean {
  return !ROTATION_WORD.test(title)
}

type FramingFields = Readonly<{
  framing?: NarrativeFraming
  framingMaturedAt?: string
  framingEvidence?: string[]
}>

function matureFramingFields(entry: NarrativeLogEntry): FramingFields {
  return {
    ...(entry.framing !== undefined ? { framing: entry.framing } : {}),
    ...(entry.framingMaturedAt !== undefined
      ? { framingMaturedAt: entry.framingMaturedAt }
      : {}),
    ...(entry.framingEvidence !== undefined
      ? { framingEvidence: [...entry.framingEvidence] }
      : {}),
  }
}

function pickFramingSurvivor(
  prior: NarrativeLogEntry,
  entry: NarrativeLogEntry,
  preferEntry: boolean,
): FramingFields {
  const priorMature = isMatureFraming(effectiveFraming(prior))
  const entryMature = isMatureFraming(effectiveFraming(entry))

  if (priorMature && entryMature) {
    const priorAt = Date.parse(prior.framingMaturedAt!)
    const entryAt = Date.parse(entry.framingMaturedAt!)
    const keepPrior = priorAt <= entryAt
    return matureFramingFields(keepPrior ? prior : entry)
  }
  if (priorMature) return matureFramingFields(prior)
  if (entryMature) return matureFramingFields(entry)
  // Both immature: follow preferEntry for optional explicit rotation / omit
  if (preferEntry) {
    return entry.framing !== undefined ? { framing: entry.framing } : {}
  }
  return prior.framing !== undefined ? { framing: prior.framing } : {}
}

function pickTitle(
  prior: NarrativeLogEntry,
  entry: NarrativeLogEntry,
  preferEntry: boolean,
  framing: FramingFields,
): string {
  const mature = isMatureFraming(framing.framing)
  if (!preferEntry) {
    return prior.title
  }
  if (mature && !titleOkForMature(entry.title)) {
    return prior.title
  }
  return entry.title
}

export const NarrativeLogEntrySchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(64),
  title: z.string().min(1).max(128),
  firstSeen: z.string().datetime(),
  lastSeen: z.string().datetime(),
  evidence: z.array(z.string().min(1).max(256)).max(32),
  stage: z.enum(["emerging", "peaking", "fading"]),
  tickers: z.array(z.string().min(1).max(32)).max(8).optional(),
  sourceProvenanceIds: z.array(z.string().min(1).max(256)).max(32).optional(),
  contributingHandles: z.array(HandleSchema).max(16).optional(),
  framing: NarrativeFramingSchema.optional(),
  framingMaturedAt: z.string().datetime().optional(),
  framingEvidence: z.array(z.string().min(1).max(256)).max(16).optional(),
}).superRefine((entry, ctx) => {
  if (!framingFieldsValid(entry)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "invalid narrative framing fields",
    })
  }
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
  dossiersMarkedDormant: number
  path: string
}>

export function narrativeLogPath(agentRoot: string): string {
  return join(agentRoot, "state", "narratives", "log.jsonl")
}

export function narrativeDossierPath(agentRoot: string, slug: string): string {
  return join(agentRoot, "state", "narratives", `${slug}.md`)
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

function isWithinRetention(lastSeenIso: string, nowMs: number, retentionDays: number): boolean {
  const lastSeenMs = Date.parse(lastSeenIso)
  if (!Number.isFinite(lastSeenMs)) return false
  return nowMs - lastSeenMs <= retentionDays * MS_PER_DAY
}

/** Extract X handles from twitter:@handle / twitter:@handle:id provenances. */
export function handleFromTwitterProvenance(raw: string): string | undefined {
  const match = raw.match(/^(?:twitter|x):@([A-Za-z0-9_]{1,15})(?::|$)/u)
  if (!match?.[1]) return undefined
  return normalizeHandle(match[1])
}

export function contributingHandlesFromEntry(entry: NarrativeLogEntry): string[] {
  const out = new Set<string>()
  for (const handle of entry.contributingHandles ?? []) {
    const normalized = normalizeHandle(handle)
    if (normalized) out.add(normalized)
  }
  for (const id of entry.sourceProvenanceIds ?? []) {
    const handle = handleFromTwitterProvenance(id)
    if (handle) out.add(handle)
  }
  for (const evidence of entry.evidence) {
    const handle = handleFromTwitterProvenance(evidence)
    if (handle) out.add(handle)
  }
  return [...out]
}

function mergeOptionalStringLists(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
  preferB: boolean,
  max: number,
): string[] | undefined {
  const primary = preferB ? b : a
  const secondary = preferB ? a : b
  if (!primary && !secondary) return undefined
  const merged = [...new Set([...(primary ?? []), ...(secondary ?? [])])].slice(0, max)
  return merged.length > 0 ? merged : undefined
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
  /** Slugs age-pruned with no surviving line — their dossier goes dormant */
  purgedSlugs: string[]
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
  const agePrunedSlugs = new Set<string>()
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
      agePrunedSlugs.add(entry.slug)
      continue
    }
    const prior = bySlug.get(entry.slug)
    if (!prior) {
      bySlug.set(entry.slug, entry)
      continue
    }
    const preferEntry = Date.parse(prior.lastSeen) < Date.parse(entry.lastSeen)
    const mergedHandles = mergeOptionalStringLists(
      prior.contributingHandles,
      entry.contributingHandles,
      preferEntry,
      16,
    )
    const mergedProvenance = mergeOptionalStringLists(
      prior.sourceProvenanceIds,
      entry.sourceProvenanceIds,
      preferEntry,
      32,
    )
    const framing = pickFramingSurvivor(prior, entry, preferEntry)
    const title = pickTitle(prior, entry, preferEntry, framing)
    const tickers = preferEntry
      ? entry.tickers ?? prior.tickers
      : prior.tickers ?? entry.tickers
    const merged: NarrativeLogEntry = {
      slug: entry.slug,
      title,
      firstSeen: Date.parse(prior.firstSeen) <= Date.parse(entry.firstSeen)
        ? prior.firstSeen
        : entry.firstSeen,
      lastSeen: preferEntry ? entry.lastSeen : prior.lastSeen,
      stage: preferEntry ? entry.stage : prior.stage,
      evidence: preferEntry ? entry.evidence : prior.evidence,
      ...(tickers ? { tickers } : {}),
      ...(mergedHandles ? { contributingHandles: mergedHandles } : {}),
      ...(mergedProvenance ? { sourceProvenanceIds: mergedProvenance } : {}),
      ...(framing.framing !== undefined ? { framing: framing.framing } : {}),
      ...(framing.framingMaturedAt ? { framingMaturedAt: framing.framingMaturedAt } : {}),
      ...(framing.framingEvidence ? { framingEvidence: framing.framingEvidence } : {}),
    }
    bySlug.set(entry.slug, merged)
  }

  const entries = [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug))
  const purgedSlugs = [...agePrunedSlugs].filter((slug) => !bySlug.has(slug)).sort()
  return { entries, kept: entries.length, purged, malformed, purgedSlugs }
}

function serializeLog(entries: readonly NarrativeLogEntry[]): string {
  if (entries.length === 0) return ""
  return `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`
}

export function narrativeProposalsPath(agentRoot: string, runId: string): string {
  return join(agentRoot, "reports", runId, "narrative-proposals.jsonl")
}

function parseProposalEntries(raw: string): Readonly<{
  entries: NarrativeLogEntry[]
  malformed: number
}> {
  let malformed = 0
  const entries: NarrativeLogEntry[] = []
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
    if (Date.parse(result.data.firstSeen) > Date.parse(result.data.lastSeen)) {
      malformed += 1
      continue
    }
    entries.push(result.data)
  }
  return { entries, malformed }
}

/**
 * Host-merge agent narrative proposals into state/narratives/log.jsonl.
 * Proposal file is untrusted: malformed lines are dropped. Existing log entries
 * survive unless a valid proposal updates the same slug.
 * Credits X narrative sources cited via contributingHandles / provenances.
 */
export async function mergeNarrativeProposals(args: Readonly<{
  agentRoot: string
  runId: string
  nowIso: string
}>): Promise<Readonly<{
  merged: number
  malformed: number
  credited: number
  path: string
}>> {
  const hold = (await import("../remediation/integrity-hold.js")).loadIntegrityHold()
  if (hold && !args.runId.startsWith("remediation-")) {
    return {
      merged: 0,
      malformed: 0,
      credited: 0,
      path: narrativeLogPath(args.agentRoot),
    }
  }
  const proposalPath = narrativeProposalsPath(args.agentRoot, args.runId)
  const logPath = narrativeLogPath(args.agentRoot)
  const existingRaw = existsSync(logPath) ? readFileSync(logPath, "utf8") : ""
  const proposalRaw = existsSync(proposalPath) ? readFileSync(proposalPath, "utf8") : ""
  const proposals = parseProposalEntries(proposalRaw)
  // Merge by feeding existing + proposals through the same prune/collapse path with
  // a long retention so we only schema-filter and dedupe here; age prune is separate.
  const existingEntries = pruneNarrativeLogInMemory(existingRaw, args.nowIso, 3650).entries
  const beforeBySlug = new Map(existingEntries.map((e) => [e.slug, e]))
  const combined = [existingRaw, proposalRaw].filter((s) => s.trim().length > 0).join("\n")
  const { entries, malformed: pruneMalformed } = pruneNarrativeLogInMemory(combined, args.nowIso, 3650)
  await writeAtomicFileFsync(logPath, serializeLog(entries))

  try {
    const {
      loadMarketClaimIndex,
      saveMarketClaimIndex,
      upsertMarketClaim,
      recordFromNarrativeTransition,
    } = await import("./market-claims.js")
    let index = loadMarketClaimIndex(args.agentRoot)
    let changed = false
    for (const after of entries) {
      const before = beforeBySlug.get(after.slug)
      if (before && before.stage === after.stage) continue
      // Only index when this run proposed the slug
      if (!proposals.entries.some((p) => p.slug === after.slug)) continue
      const record = recordFromNarrativeTransition({
        runId: args.runId,
        before,
        after,
      })
      if (!record) continue
      index = upsertMarketClaim(index, record)
      changed = true
    }
    if (changed) await saveMarketClaimIndex(args.agentRoot, index)
  } catch {
    // claim index is best-effort; never fail narrative merge
  }

  let credited = 0
  try {
    const state = new StateStore(join(args.agentRoot, "state"))
    let narrativeSources = state.loadXNarrativeSources()
    let changed = false
    for (const proposal of proposals.entries) {
      for (const handle of contributingHandlesFromEntry(proposal)) {
        narrativeSources = creditNarrativeContribution(narrativeSources, {
          handle,
          narrativeSlug: proposal.slug,
          at: proposal.lastSeen,
        })
        credited += 1
        changed = true
      }
    }
    if (changed) await state.saveXNarrativeSources(narrativeSources)
  } catch {
    credited = 0
  }

  const proposalCount = proposalRaw.split("\n").filter((l) => l.trim().length > 0).length
  return {
    merged: Math.min(proposalCount, entries.length),
    malformed: proposals.malformed + pruneMalformed,
    credited,
    path: "state/narratives/log.jsonl",
  }
}

const DOSSIER_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(\n|$)/u
const STATUS_LINE_RE = /^status:.*$/mu

/**
 * Set `status: dormant` in a narrative dossier's frontmatter when the host
 * prunes its slug from the log (ADR 045). Keeps the body byte-for-byte;
 * inserts a frontmatter block when the dossier has none. Returns false when
 * the dossier is missing or already dormant.
 */
export async function markNarrativeDossierDormant(
  agentRoot: string,
  slug: string,
): Promise<boolean> {
  if (!DOSSIER_SLUG_RE.test(slug)) return false
  const path = narrativeDossierPath(agentRoot, slug)
  const st = statSync(path, { throwIfNoEntry: false })
  if (!st?.isFile()) return false
  const raw = readFileSync(path, "utf8")

  let next: string
  const frontmatter = FRONTMATTER_RE.exec(raw)
  if (frontmatter) {
    const block = frontmatter[1]!
    if (STATUS_LINE_RE.test(block)) {
      const updated = block.replace(STATUS_LINE_RE, "status: dormant")
      if (updated === block) return false
      next = raw.replace(frontmatter[0], `---\n${updated}\n---${frontmatter[2]}`)
    } else {
      next = raw.replace(frontmatter[0], `---\n${block}\nstatus: dormant\n---${frontmatter[2]}`)
    }
  } else {
    next = `---\nstatus: dormant\n---\n\n${raw}`
  }
  if (next === raw) return false
  await writeAtomicFileFsync(path, next)
  return true
}

/**
 * Host prune of the narrative log. Creates an empty file when missing so the next
 * agent session has a stable path. Marks the dossier of every fully purged slug
 * dormant. Archives a receipt under the run directory when layout is provided.
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
  const { entries, kept, purged, malformed, purgedSlugs } = pruneNarrativeLogInMemory(
    raw,
    args.nowIso,
    args.retentionDays,
  )
  await writeAtomicFileFsync(path, serializeLog(entries))

  let dossiersMarkedDormant = 0
  for (const slug of purgedSlugs) {
    if (await markNarrativeDossierDormant(args.agentRoot, slug)) {
      dossiersMarkedDormant += 1
    }
  }

  const report: NarrativeLogPruneReport = {
    schema: 1,
    runId: args.runId,
    prunedAt: args.nowIso,
    retentionDays: args.retentionDays,
    kept,
    purged,
    malformed,
    dossiersMarkedDormant,
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

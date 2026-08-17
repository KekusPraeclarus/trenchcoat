import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { loadConfig } from "../lib/config.js"
import { StateStore } from "../lib/state.js"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { archiveLayout } from "../lib/archive.js"
import { SnapshotEnvelopeSchema } from "../contracts/schemas.js"
import {
  applyClassificationResult,
  type XSourceNominationStatus,
} from "../sources/x-nominations.js"
import { registerNarrativeProbation } from "../sources/narrative-lifecycle.js"
import { registerDiscoveryCandidates, sourceIdForHandle } from "../sources/lifecycle.js"
import { appendSourceCallEventsFromItems } from "./call-log.js"
import { provenanceToSource } from "./rug-dock.js"
import { extractCallEvents } from "../lib/call-events.js"
import { isQuoteOrNativeMint } from "../lib/native-mints.js"

const ReasonCodeSchema = z.enum([
  "shill-dense",
  "narrative-dense",
  "mixed-role",
  "thin-sample",
  "noise-dominant",
  "promo-account",
  "unrelated",
])

export const FomoXClassificationSchema = z.object({
  schema: z.literal(1),
  nominationId: z.string().min(8).max(64),
  xHandle: z.string().min(1).max(15).regex(/^[A-Za-z0-9_]+$/u),
  classification: z.enum(["shiller", "narrative", "both", "reject"]),
  confidence: z.number().min(0).max(1),
  shillPostIds: z.array(z.string().min(1).max(64)).max(200).default([]),
  narrativePostIds: z.array(z.string().min(1).max(64)).max(200).default([]),
  noisePostIds: z.array(z.string().min(1).max(64)).max(200).default([]),
  reasonCodes: z.array(ReasonCodeSchema).max(8).default([]),
})

export type FomoXClassification = z.infer<typeof FomoXClassificationSchema>

export type ClassificationMergeReport = Readonly<{
  ok: boolean
  reason: string
  nominationId?: string
  status?: XSourceNominationStatus
  classification?: FomoXClassification["classification"]
  narrativeRegistered?: boolean
  shillerBackfillNote?: string
  callCount?: number
  distinctTokens?: number
}>

const MIN_SHILLER_CALLS = 10
const MIN_SHILLER_TOKENS = 5

function classificationPath(agentRoot: string, runId: string): string {
  return join(agentRoot, "reports", runId, "fomo-x-classification.json")
}

function parseSealedPostIds(agentRoot: string, runId: string): ReadonlySet<string> {
  const path = join(agentRoot, "inbox", runId, "x-source-manifest.json")
  if (!existsSync(path)) return new Set()
  try {
    const envelope = SnapshotEnvelopeSchema.parse(JSON.parse(readFileSync(path, "utf8")))
    const text = envelope.items[0]?.text ?? ""
    const match = text.match(/sealedPostIds=([^\s]+)/u)
    if (!match?.[1] || match[1] === "") return new Set()
    return new Set(match[1].split(",").filter(Boolean))
  } catch {
    return new Set()
  }
}

function parseManifestHandle(agentRoot: string, runId: string): string | undefined {
  const path = join(agentRoot, "inbox", runId, "x-source-manifest.json")
  if (!existsSync(path)) return undefined
  try {
    const envelope = SnapshotEnvelopeSchema.parse(JSON.parse(readFileSync(path, "utf8")))
    const text = envelope.items[0]?.text ?? ""
    const match = text.match(/xHandle=([A-Za-z0-9_]+)/u)
    return match?.[1]?.toLowerCase()
  } catch {
    return undefined
  }
}

function allIdsSealed(
  ids: readonly string[],
  sealed: ReadonlySet<string>,
): boolean {
  return ids.every((id) => sealed.has(id))
}

function loadSealedHistoryItems(
  agentRoot: string,
  runId: string,
): ReadonlyArray<{ provenance: string, text: string, ts: string }> {
  const path = join(agentRoot, "inbox", runId, "x-source-history.json")
  if (!existsSync(path)) return []
  try {
    const envelope = SnapshotEnvelopeSchema.parse(JSON.parse(readFileSync(path, "utf8")))
    return envelope.items
      .filter((item) => typeof item.provenance === "string" && typeof item.text === "string")
      .map((item) => ({
        provenance: item.provenance,
        text: item.text,
        ts: typeof item.ts === "string" ? item.ts : envelope.fetchedAt,
      }))
  } catch {
    return []
  }
}

function loadSealedProfileCallItems(
  agentRoot: string,
  runId: string,
): ReadonlyArray<{ provenance: string, text: string, ts: string }> {
  const path = join(agentRoot, "inbox", runId, "fomo-profile-calls.json")
  if (!existsSync(path)) return []
  try {
    const envelope = SnapshotEnvelopeSchema.parse(JSON.parse(readFileSync(path, "utf8")))
    return envelope.items
      .filter((item) => (
        typeof item.provenance === "string"
        && item.provenance.startsWith("fomo-profile:@")
        && typeof item.text === "string"
        && item.text.includes("purpose=fomo-profile-call")
      ))
      .map((item) => ({
        provenance: item.provenance,
        text: item.text,
        ts: typeof item.ts === "string" ? item.ts : envelope.fetchedAt,
      }))
  } catch {
    return []
  }
}

function resolveShillerSourceId(xHandle: string, provenance: string): string {
  const mapped = provenanceToSource(provenance.includes(":") ? provenance.split(":").slice(0, 2).join(":") : `twitter:@${xHandle}`)
  if (mapped) return mapped.sourceId
  return sourceIdForHandle(xHandle)
}

async function writeShillerBackfillNote(
  archiveRoot: string,
  note: Readonly<Record<string, unknown>>,
  nominationId: string,
): Promise<string> {
  const path = join(
    archiveRoot,
    "fomo-x-source-review",
    nominationId,
    "shiller-backfill.json",
  )
  await writeAtomicFile(path, `${JSON.stringify(note, null, 2)}\n`)
  return path
}

async function runShillerBackfill(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  runId: string
  nowIso: string
  nominationId: string
  xHandle: string
}>): Promise<Readonly<{
  ok: boolean
  reason: string
  notePath: string
  callCount: number
  distinctTokens: number
}>> {
  const handle = args.xHandle.toLowerCase()
  const history = loadSealedHistoryItems(args.agentRoot, args.runId)
  const profileCalls = loadSealedProfileCallItems(args.agentRoot, args.runId)
  const sourceId = resolveShillerSourceId(handle, `twitter:@${handle}`)
  const layout = archiveLayout(args.archiveRoot)

  const historyItems = history.map((item) => ({
    provenance: item.provenance.startsWith("twitter:@") || item.provenance.startsWith("x:@")
      ? item.provenance
      : `twitter:@${handle}`,
    text: item.text,
    ts: item.ts,
  }))
  const fomoItems = profileCalls.map((item) => ({
    provenance: item.provenance,
    text: item.text,
    ts: item.ts,
  }))

  const historyCalls = historyItems.flatMap((item) => extractCallEvents({
    sourceId,
    provenance: item.provenance,
    text: item.text,
    mentionedAt: item.ts,
  })).filter((call) => call.chainHint === "evm" || call.chainHint === "solana")
  const fomoCalls = fomoItems.flatMap((item) => extractCallEvents({
    sourceId,
    provenance: item.provenance,
    text: item.text,
    mentionedAt: item.ts,
  })).filter((call) => (
    (call.chainHint === "evm" || call.chainHint === "solana")
    && !isQuoteOrNativeMint(call.rawAddress)
  ))
  const eligibleCalls = [...historyCalls, ...fomoCalls]

  const callCount = eligibleCalls.length
  const distinctTokens = new Set(
    eligibleCalls.map((call) => call.rawAddress.toLowerCase()),
  ).size
  const backfillEpochDay = args.nowIso.slice(0, 10)

  const append = await appendSourceCallEventsFromItems(layout, historyItems, {
    sourceIdOverride: sourceId,
  })

  if (callCount < MIN_SHILLER_CALLS || distinctTokens < MIN_SHILLER_TOKENS) {
    const notePath = await writeShillerBackfillNote(args.archiveRoot, {
      schema: 1,
      runId: args.runId,
      nominationId: args.nominationId,
      xHandle: handle,
      status: "insufficient-call-history",
      backfillEpochDay,
      callCount,
      distinctTokens,
      xCallCount: historyCalls.length,
      profileCallCount: fomoCalls.length,
      appended: append.appended,
      note: "Below call/token thresholds — not registered into source-lifecycle. FOMO swaps count for entry only.",
    }, args.nominationId)
    return {
      ok: false,
      reason: "insufficient-call-history",
      notePath,
      callCount,
      distinctTokens,
    }
  }

  const state = new StateStore(join(args.agentRoot, "state"))
  const lifecycle = registerDiscoveryCandidates(
    state.loadSourceLifecycle(),
    [{ handle, origin: "fomo-leaderboard" }],
    args.nowIso,
  )
  await state.saveSourceLifecycle(lifecycle)

  const notePath = await writeShillerBackfillNote(args.archiveRoot, {
    schema: 1,
    runId: args.runId,
    nominationId: args.nominationId,
    xHandle: handle,
    status: "awaiting-review-epoch",
    backfillEpochDay,
    callCount,
    distinctTokens,
    xCallCount: historyCalls.length,
    profileCallCount: fomoCalls.length,
    appended: append.appended,
    note: "Registered fomo-leaderboard probation only. FOMO swaps count for entry. X-post CAs enter the call log.",
  }, args.nominationId)

  return {
    ok: true,
    reason: "awaiting-review-epoch",
    notePath,
    callCount,
    distinctTokens,
  }
}

/**
 * Fail-closed merge of agent classification JSON against the sealed post manifest.
 * Historical posts stay in x-source-history / call-log only — never live narrative snapshots.
 */
export async function mergeFomoXClassification(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  runId: string
  nowIso: string
}>): Promise<ClassificationMergeReport> {
  const config = loadConfig()
  const path = classificationPath(args.agentRoot, args.runId)
  if (!existsSync(path)) {
    return failClosed(args, "missing-classification")
  }

  let parsed: FomoXClassification
  try {
    parsed = FomoXClassificationSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return failClosed(args, "malformed-classification")
  }

  const sealed = parseSealedPostIds(args.agentRoot, args.runId)
  if (sealed.size === 0) {
    return failClosed(args, "missing-sealed-manifest", parsed.nominationId)
  }

  const manifestHandle = parseManifestHandle(args.agentRoot, args.runId)
  if (!manifestHandle || manifestHandle !== parsed.xHandle.toLowerCase()) {
    return failClosed(args, "handle-mismatch", parsed.nominationId)
  }

  const cited = [...parsed.shillPostIds, ...parsed.narrativePostIds, ...parsed.noisePostIds]
  if (!allIdsSealed(cited, sealed)) {
    return failClosed(args, "unsealed-post-ids", parsed.nominationId)
  }

  const minEvidence = config.fomo.x_source_review.min_role_evidence_posts
  if (parsed.confidence < 0.70) {
    return failClosed(args, "low-confidence", parsed.nominationId)
  }
  if (sealed.size < config.fomo.x_source_review.min_posts) {
    return failClosed(args, "thin-sample", parsed.nominationId)
  }

  if (parsed.classification === "shiller" || parsed.classification === "both") {
    if (parsed.shillPostIds.length < minEvidence) {
      return failClosed(args, "insufficient-shill-evidence", parsed.nominationId)
    }
  }
  if (parsed.classification === "narrative" || parsed.classification === "both") {
    if (parsed.narrativePostIds.length < minEvidence) {
      return failClosed(args, "insufficient-narrative-evidence", parsed.nominationId)
    }
  }

  const state = new StateStore(join(args.agentRoot, "state"))
  let nominations = state.loadXSourceNominations()
  const nomination = nominations.nominations.find((item) => item.nominationId === parsed.nominationId)
  if (!nomination || nomination.status !== "classifying") {
    return { ok: false, reason: "nomination-not-classifying", nominationId: parsed.nominationId }
  }

  if (parsed.classification === "reject") {
    nominations = applyClassificationResult(nominations, {
      nominationId: parsed.nominationId,
      status: "rejected",
      classification: "reject",
      classificationRunId: args.runId,
    })
    await state.saveXSourceNominations(nominations)
    return {
      ok: true,
      reason: "rejected",
      nominationId: parsed.nominationId,
      status: "rejected",
      classification: "reject",
    }
  }

  nominations = applyClassificationResult(nominations, {
    nominationId: parsed.nominationId,
    status: "classified",
    classification: parsed.classification,
    classificationRunId: args.runId,
  })
  await state.saveXSourceNominations(nominations)

  let narrativeRegistered = false
  if (
    (parsed.classification === "narrative" || parsed.classification === "both")
    && config.fomo.narrative_source_probation.enabled
  ) {
    const narrative = registerNarrativeProbation(
      state.loadXNarrativeSources(),
      parsed.xHandle,
      args.nowIso,
      config.fomo.narrative_source_probation.probation_days,
    )
    await state.saveXNarrativeSources(narrative)
    narrativeRegistered = true
  }

  let shillerBackfillNote: string | undefined
  let callCount: number | undefined
  let distinctTokens: number | undefined
  let status: XSourceNominationStatus = "classified"

  if (parsed.classification === "shiller" || parsed.classification === "both") {
    const backfill = await runShillerBackfill({
      agentRoot: args.agentRoot,
      archiveRoot: args.archiveRoot,
      runId: args.runId,
      nowIso: args.nowIso,
      nominationId: parsed.nominationId,
      xHandle: parsed.xHandle,
    })
    shillerBackfillNote = backfill.notePath
    callCount = backfill.callCount
    distinctTokens = backfill.distinctTokens
    if (!backfill.ok) {
      nominations = applyClassificationResult(nominations, {
        nominationId: parsed.nominationId,
        status: "insufficient-history",
        classification: parsed.classification,
        classificationRunId: args.runId,
      })
      await state.saveXSourceNominations(nominations)
      status = "insufficient-history"
    }
  }

  return {
    ok: true,
    reason: status === "insufficient-history" ? "insufficient-call-history" : "classified",
    nominationId: parsed.nominationId,
    status,
    classification: parsed.classification,
    narrativeRegistered,
    ...(shillerBackfillNote ? { shillerBackfillNote } : {}),
    ...(callCount !== undefined ? { callCount } : {}),
    ...(distinctTokens !== undefined ? { distinctTokens } : {}),
  }
}

async function failClosed(
  args: Readonly<{ agentRoot: string, runId: string, nowIso: string }>,
  reason: string,
  nominationId?: string,
): Promise<ClassificationMergeReport> {
  const config = loadConfig()
  const state = new StateStore(join(args.agentRoot, "state"))
  let nominations = state.loadXSourceNominations()
  const classifying = nominations.nominations.find((item) => (
    item.status === "classifying"
    && (!nominationId || item.nominationId === nominationId)
  ))
  if (!classifying) {
    return { ok: false, reason, ...(nominationId ? { nominationId } : {}) }
  }

  const status: XSourceNominationStatus = classifying.attempts >= config.fomo.x_source_review.max_attempts
    ? "unreviewable"
    : "pending"
  nominations = applyClassificationResult(nominations, {
    nominationId: classifying.nominationId,
    status,
    ...(status === "pending"
      ? {
        reviewAfter: new Date(
          Date.parse(args.nowIso) + config.fomo.x_source_review.retry_after_hours * 3_600_000,
        ).toISOString(),
      }
      : {}),
  })
  await state.saveXSourceNominations(nominations)
  return {
    ok: false,
    reason,
    nominationId: classifying.nominationId,
    status,
  }
}

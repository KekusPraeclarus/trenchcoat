import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Outbox } from "../lib/outbox.js"
import { runArchiveDir, writeJsonRecordFsync, type ArchiveLayout } from "../lib/archive.js"
import { sha256Json } from "../lib/canonical-json.js"
import { canonicalizeBroadcastRefs } from "./broadcast-refs.js"
import { evaluateMechanicalBroadcastGate } from "./broadcast-mechanical-gate.js"
import {
  claimHash,
  runBroadcastWorthiness,
  type WorthinessContext,
  type WorthinessSessionRunner,
} from "./broadcast-worthiness.js"
import {
  loadWorthinessCache,
  lookupWorthinessCache,
  saveWorthinessCache,
  upsertWorthinessCache,
  worthinessCacheApplies,
  type WorthinessCache,
} from "./broadcast-worthiness-cache.js"
import type { NarrativeLogEntry } from "./narrative-log.js"
import { assertNarrativeDevelopmentAllowed } from "./narrative-development.js"
import {
  assertNarrativeEvidenceQuality,
  type NarrativeEvidenceQuality,
} from "./narrative-evidence-gate.js"
import {
  assertNarrativeBroadcastAllowed,
  restatesUnchangedNarrativeStage,
  statusQuoNarratives,
  type StageKnown,
} from "./narrative-stage-dedupe.js"
import { maturedNarrativeLabels, usesStaleRotationFraming } from "../lib/narrative-label.js"
import { effectiveFraming } from "../lib/narrative-framing.js"
import {
  capSeverityForPlatformCoverage,
  resolveSocialPlatformsForClaim,
} from "./platform-coverage.js"
import { buildBroadcastRouterEvent, validateBroadcastItem } from "./router.js"
import type { BroadcastItem, BroadcastRejectReceipt } from "../contracts/schemas.js"
import {
  jobHeldByIntegrity,
  loadIntegrityHold,
} from "../remediation/integrity-hold.js"
import {
  extractBroadcastClaimsFromArchive,
  extractWorthinessBroadcastCandidates,
  loadMarketClaimIndex,
  recordFromBroadcastEvent,
  saveMarketClaimIndex,
  upsertMarketClaim,
} from "./market-claims.js"

/** agent/outbox/<run-id>.json — zero or more untrusted broadcast proposals */
export function outboxProposalPath(agentRoot: string, runId: string): string {
  return join(agentRoot, "outbox", `${runId}.json`)
}

export const OUTBOX_ITEMS_MAX = 8

type ProposedRead =
  | Readonly<{ ok: true; items: unknown[] }>
  | Readonly<{ ok: false; reason: string }>

/**
 * Accept `{ schema, items: [...] }` or a bare array. Wrong envelopes (e.g. `broadcasts`
 * or a lone `text` field) fail closed with an auditable reason — never silent empty.
 */
export function readProposedItems(agentRoot: string, runId: string): ProposedRead {
  const path = outboxProposalPath(agentRoot, runId)
  if (!existsSync(path)) return { ok: true, items: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return { ok: false, reason: "invalid-envelope:json-parse" }
  }
  if (Array.isArray(parsed)) return { ok: true, items: parsed }
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, reason: "invalid-envelope:not-object-or-array" }
  }
  const record = parsed as Record<string, unknown>
  if (Array.isArray(record["items"])) {
    return { ok: true, items: record["items"] }
  }
  if ("broadcasts" in record) {
    return { ok: false, reason: "invalid-envelope:use-items-not-broadcasts" }
  }
  if ("text" in record && !("items" in record)) {
    return { ok: false, reason: "invalid-envelope:wrap-text-in-items-array" }
  }
  if ("items" in record) {
    return { ok: false, reason: "invalid-envelope:items-not-array" }
  }
  return { ok: false, reason: "invalid-envelope:missing-items" }
}

export type OutboxIngestReport = Readonly<{
  staged: number
  rejected: number
  rejects: readonly { reason: string; itemHash?: `sha256:${string}` }[]
  items: readonly BroadcastItem[]
}>

/**
 * Validate the agent's broadcast proposals and stage survivors as durable
 * RouterEvents. After mechanical gates, an optional host worthiness session
 * (fail-closed) must approve before stage. Telegram is topic-scoped at render
 * (one message per subject per run); Discord daily budget is applied later in
 * `renderChannelPayloads`. Rejections are archived with a receipt.
 */
export async function ingestOutbox(args: Readonly<{
  agentRoot: string
  layout: ArchiveLayout
  runId: string
  nowIso: string
  marketBlind?: boolean
  /** Job name for integrity-hold gating */
  job?: string
  /** Curated social evidence grade — narrative claims need tier `strong` */
  narrativeEvidenceQuality?: NarrativeEvidenceQuality
  /** Pre-session narrative log — used to reject same-heat re-sightings */
  narrativeLogBefore?: readonly NarrativeLogEntry[]
  /** Post-merge narrative log — stage deltas unlock heat-change broadcasts */
  narrativeLogAfter?: readonly NarrativeLogEntry[]
  /** Thin-watch research subjects blocked from broadcast (normalized lowercase). */
  blockThinResearchBroadcastSubjects?: ReadonlySet<string>
  /** Host worthiness gate — omitted/disabled skips the LLM review */
  worthiness?: Readonly<{
    enabled: boolean
    runSession?: WorthinessSessionRunner
    context: WorthinessContext
    /** Operator-approved worthiness guidance lines (ADR 043) */
    guidance?: readonly string[]
  }>
}>): Promise<OutboxIngestReport> {
  const proposed = readProposedItems(args.agentRoot, args.runId)
  const outbox = new Outbox(join(args.layout.routerOutbox, args.runId))

  const accepted: BroadcastItem[] = []
  const rejects: { reason: string; itemHash?: `sha256:${string}` }[] = []
  const receipts: BroadcastRejectReceipt[] = []
  const logBefore = args.narrativeLogBefore ?? []
  const logAfter = args.narrativeLogAfter
  const statusQuo = statusQuoNarratives(logBefore, logAfter)
  const framingSource = logAfter ?? logBefore
  const maturedNarratives = maturedNarrativeLabels(
    framingSource.map((entry) => ({
      slug: entry.slug,
      title: entry.title,
      framing: effectiveFraming(entry),
    })),
  )
  const worthinessEnabled = args.worthiness?.enabled === true
  const worthinessStatusQuo: readonly StageKnown[] =
    args.worthiness?.context.statusQuoStages ?? statusQuo
  const recentAcceptedClaims = extractBroadcastClaimsFromArchive({
    layout: args.layout,
    startExclusive: new Date(
      Date.parse(args.nowIso) - 48 * 3_600_000,
    ).toISOString(),
    endInclusive: args.nowIso,
    acceptedOnly: true,
  })
  const worthinessCandidates = extractWorthinessBroadcastCandidates({
    layout: args.layout,
    startExclusive: new Date(
      Date.parse(args.nowIso) - 48 * 3_600_000,
    ).toISOString(),
    endInclusive: args.nowIso,
  })

  const reject = (reason: string, itemHash?: `sha256:${string}`): void => {
    rejects.push(itemHash ? { reason, itemHash } : { reason })
    receipts.push({
      schema: 1,
      rejectId: sha256Json({ runId: args.runId, reason, itemHash: itemHash ?? null }),
      runId: args.runId,
      reason,
      ...(itemHash ? { itemHash } : {}),
      rejectedAt: args.nowIso,
    })
  }

  if (!proposed.ok) {
    reject(proposed.reason)
    await writeJsonRecordFsync(
      join(runArchiveDir(args.layout, args.runId), "broadcast-rejects.json"),
      { schema: 1, runId: args.runId, rejectedAt: args.nowIso, rejects: receipts } as never,
    )
    return { staged: 0, rejected: 1, rejects, items: [] }
  }

  const hold = loadIntegrityHold()
  if (args.job && jobHeldByIntegrity(hold, args.job)) {
    reject(`integrity-hold:${hold?.incidentId ?? "active"}`)
    await writeJsonRecordFsync(
      join(runArchiveDir(args.layout, args.runId), "broadcast-rejects.json"),
      { schema: 1, runId: args.runId, rejectedAt: args.nowIso, rejects: receipts } as never,
    )
    return { staged: 0, rejected: 1, rejects, items: [] }
  }

  let staged = 0
  let claimIndex = loadMarketClaimIndex(args.agentRoot)
  const loopHistory = [...worthinessCandidates]
  const proposedSubjectsSeen = new Set<string>()
  const proposedClaimHashes = new Set<string>()
  let worthinessCache: WorthinessCache | undefined
  let worthinessCacheDirty = false
  if (worthinessEnabled) {
    worthinessCache = loadWorthinessCache(args.agentRoot, {
      nowIso: args.nowIso,
      ...(logBefore.length > 0 ? { narrativeLogBefore: logBefore } : {}),
      ...(logAfter ? { narrativeLogAfter: logAfter } : {}),
    })
  }
  let itemIndex = 0
  for (const raw of proposed.items) {
    if (itemIndex >= OUTBOX_ITEMS_MAX) {
      reject("outbox-items-cap", sha256Json(raw as never))
      itemIndex += 1
      continue
    }
    itemIndex += 1
    const rawHash = sha256Json(raw as never)
    let item: BroadcastItem
    try {
      item = validateBroadcastItem(raw)
    } catch (error) {
      reject(error instanceof Error ? error.message.slice(0, 280) : "invalid-item", rawHash)
      continue
    }

    // Host gate: category rotation confirmation is missing when market-blind
    if (args.marketBlind) {
      const claim = item.auditClaim
      const isRotation = claim?.type === "rotation"
        || claim?.verificationRule === "rotation"
      const isUrgentRotation = item.severity === "urgent" && isRotation
      if (isRotation || isUrgentRotation) {
        reject("market-blind:rotation-forbidden", rawHash)
        continue
      }
    }

    const evidenceGate = assertNarrativeEvidenceQuality({
      item,
      ...(args.narrativeEvidenceQuality
        ? { quality: args.narrativeEvidenceQuality }
        : {}),
    })
    if (!evidenceGate.ok) {
      reject(evidenceGate.reason, rawHash)
      continue
    }

    const stageGate = assertNarrativeBroadcastAllowed({
      item,
      logBefore,
      ...(logAfter ? { logAfter } : {}),
    })
    if (!stageGate.ok) {
      reject(stageGate.reason, rawHash)
      continue
    }

    // In-meta developments bypass the stage gate but must be genuinely new
    const developmentGate = assertNarrativeDevelopmentAllowed({
      item,
      narrativeLog: logAfter ?? logBefore,
      recentClaims: recentAcceptedClaims,
      nowIso: args.nowIso,
      ...(stageGate.sameStageDevelopment ? { sameStageDevelopment: true } : {}),
    })
    if (!developmentGate.ok) {
      reject(developmentGate.reason, rawHash)
      continue
    }

    if (statusQuo.length > 0 && restatesUnchangedNarrativeStage(item.text, statusQuo)) {
      reject("status-quo-narrative-stage", rawHash)
      continue
    }

    if (maturedNarratives.length > 0 && usesStaleRotationFraming(item.text, maturedNarratives)) {
      reject("stale-narrative-framing", rawHash)
      continue
    }

    const frozen = canonicalizeBroadcastRefs({
      agentRoot: args.agentRoot,
      layout: args.layout,
      runId: args.runId,
      refs: item.refs,
    })
    if (!frozen.ok) {
      reject(frozen.reason, rawHash)
      continue
    }
    const withDurableRefs: BroadcastItem = { ...item, refs: [...frozen.refs] }

    const platforms = resolveSocialPlatformsForClaim(args.agentRoot, withDurableRefs)
    const capped = capSeverityForPlatformCoverage(withDurableRefs, platforms)

    const mechanical = evaluateMechanicalBroadcastGate(capped, {
      proposedSubjectsSeen,
      proposedClaimHashes,
      recentAcceptedClaims,
      nowIso: args.nowIso,
      ...(args.blockThinResearchBroadcastSubjects
        ? { blockThinResearchBroadcastSubjects: args.blockThinResearchBroadcastSubjects }
        : {}),
    })
    if (!mechanical.ok) {
      reject(mechanical.reason, rawHash)
      continue
    }

    if (worthinessEnabled && args.worthiness && worthinessCache) {
      const subject = capped.auditClaim.subject.trim().toLowerCase()
      const hash = claimHash(capped.auditClaim)
      const cacheApplies = worthinessCacheApplies(capped.auditClaim)
      const cached = cacheApplies
        ? lookupWorthinessCache(worthinessCache, {
          subject,
          claimHash: hash,
          nowIso: args.nowIso,
        })
        : undefined
      if (cached) {
        if (!cached.worth) {
          reject(`worthiness:cached-not-worth:${cached.reason}`, rawHash)
          continue
        }
      } else {
        const subjectHistory = loopHistory
          .filter((entry) => entry.subject.trim().toLowerCase() === subject)
          .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
          .slice(0, 20)
          .map((entry) => ({
            occurredAt: entry.occurredAt,
            subject: entry.subject,
            summary: entry.summary,
            destinations: entry.destinations,
            status: entry.status,
          }))
        const review = await runBroadcastWorthiness({
          item: capped,
          enabled: true,
          ...(args.worthiness.guidance && args.worthiness.guidance.length > 0
            ? { guidance: args.worthiness.guidance }
            : {}),
          ...(args.worthiness.runSession
            ? { runSession: args.worthiness.runSession }
            : {}),
          context: {
            ...args.worthiness.context,
            ...(worthinessStatusQuo.length > 0
              ? { statusQuoStages: worthinessStatusQuo }
              : {}),
            ...(args.marketBlind ? { marketBlind: true } : {}),
            ...(subjectHistory.length > 0 ? { recentBroadcasts: subjectHistory } : {}),
          },
        })
        if (!review.ok) {
          reject(`worthiness:${review.reason}`, rawHash)
          continue
        }
        if (cacheApplies) {
          worthinessCache = upsertWorthinessCache(worthinessCache, {
            auditClaim: capped.auditClaim,
            worth: review.worth,
            reason: review.reason,
            decidedAt: args.nowIso,
          })
          worthinessCacheDirty = true
        }
        if (!review.worth) {
          reject(`worthiness:not-worth:${review.reason}`, rawHash)
          continue
        }
      }
    }

    // eventId is derived from run id + content only, so it is a stable idempotency
    // key across retries even though occurredAt varies.
    const event = buildBroadcastRouterEvent(args.runId, args.nowIso, capped)
    await outbox.stage(event)
    const claim = recordFromBroadcastEvent({
      event,
      // Telegram fanout is decided later by channel-render (topic leaders only);
      // destinations are updated then. Index defaults to telegram for now.
      destinations: ["telegram"],
    })
    if (claim) {
      claimIndex = upsertMarketClaim(claimIndex, claim)
    }
    accepted.push(capped)
    staged += 1
    loopHistory.unshift({
      occurredAt: args.nowIso,
      subject: capped.auditClaim.subject,
      summary: capped.text,
      destinations: ["telegram"],
      status: "staged",
      eventId: event.eventId,
    })
  }

  if (staged > 0) {
    await saveMarketClaimIndex(args.agentRoot, claimIndex)
  }
  if (worthinessCacheDirty && worthinessCache) {
    await saveWorthinessCache(args.agentRoot, worthinessCache)
  }

  await writeJsonRecordFsync(
    join(runArchiveDir(args.layout, args.runId), "broadcast-rejects.json"),
    { schema: 1, runId: args.runId, rejectedAt: args.nowIso, rejects: receipts } as never,
  )

  return { staged, rejected: rejects.length, rejects, items: accepted }
}

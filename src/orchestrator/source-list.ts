import { loadConfig, saveConfig, type TrenchcoatConfig } from "../lib/config.js"
import { StateStore } from "../lib/state.js"
import { systemClock } from "../lib/clock.js"
import { sha256Json } from "../lib/canonical-json.js"
import {
  desiredManagedHandles,
  registerDiscoveryCandidates,
  registerFypCandidates,
  reviewSourceLifecycle,
  type SourceLifecycleThresholds,
} from "../sources/lifecycle.js"
import type { DiscoverySighting } from "./collect.js"
import { aggregateSourcePerformance, type SourceCallOutcome } from "../sources/outcomes.js"
import {
  syncManagedListMembership,
  createManagedPrivateList,
  confineListId,
} from "../collectors/twitter/managed-list.js"
import type { SourceLifecycleFile, XListSyncReceipt } from "../contracts/schemas.js"
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { archiveLayout } from "../lib/archive.js"
import { loadSourceCallOutcomes } from "./sources.js"
import { SourceWriter } from "./sources-write.js"
import { readSourceCallLog } from "./call-log.js"
import { loadDiscoverySightingsFromArchive, registerSealedXCallers } from "../sources/sealed-x-callers.js"

export function thresholdsFromConfig(config: TrenchcoatConfig): SourceLifecycleThresholds {
  return {
    max_transitions_per_review: config.twitter.source_lifecycle.max_transitions_per_review,
    promotion: config.twitter.source_lifecycle.promotion,
    demotion: config.twitter.source_lifecycle.demotion,
  }
}

export function ingestFypAuthors(
  state: StateStore,
  authors: readonly string[],
  seenAt = systemClock.nowIso(),
): SourceLifecycleFile {
  const current = state.loadSourceLifecycle()
  return registerFypCandidates(current, authors, seenAt)
}

export function ingestDiscoverySightings(
  state: StateStore,
  sightings: readonly DiscoverySighting[],
  seenAt = systemClock.nowIso(),
): SourceLifecycleFile {
  const current = state.loadSourceLifecycle()
  return registerDiscoveryCandidates(current, sightings, seenAt)
}

export type SourceListReviewOptions = Readonly<{
  agentRoot: string
  archiveRoot: string
  dryRun?: boolean
  sync?: boolean
  outcomes?: readonly SourceCallOutcome[]
  epochId?: string
  nowIso?: string
}>

export type SourceListReviewReport = Readonly<{
  epochId: string
  scoreCutoff: string
  applied: number
  queued: number
  pending: number
  managed: number
  candidates: number
  sync?: XListSyncReceipt
  transitions: readonly {
    handle: string
    action: string
    reasonCode: string
  }[]
}>

export async function runSourceListReview(
  opts: SourceListReviewOptions,
): Promise<SourceListReviewReport> {
  const config = loadConfig()
  const state = new StateStore(join(opts.agentRoot, "state"))
  const nowIso = opts.nowIso ?? systemClock.nowIso()
  const epochId = opts.epochId ?? `source-review-${nowIso.slice(0, 10)}`
  const scoreCutoff = nowIso

  let file = state.loadSourceLifecycle()
  const layout = archiveLayout(opts.archiveRoot)
  const callerIngest = registerSealedXCallers(file, {
    events: readSourceCallLog(layout),
    sightings: loadDiscoverySightingsFromArchive(layout),
    nowIso,
  })
  file = callerIngest.file
  if (!opts.dryRun && callerIngest.report.registered > 0) {
    await state.saveSourceLifecycle(file)
  }
  if (config.twitter.managed_list.list_id) {
    confineListId(
      config.twitter.managed_list.list_id,
      file.managedListId ?? config.twitter.managed_list.list_id,
    )
    file = {
      ...file,
      managedListId: config.twitter.managed_list.list_id,
      ...(config.twitter.managed_list.list_url
        ? { managedListUrl: config.twitter.managed_list.list_url }
        : {}),
    }
  }

  const outcomes = opts.outcomes ?? loadSourceCallOutcomes(layout)
  const performances = new Map(
    file.candidates.map((candidate) => [
      candidate.sourceId,
      aggregateSourcePerformance(
        candidate.sourceId,
        outcomes,
        scoreCutoff,
        config.audit.source_score_prior_strength,
      ),
    ]),
  )

  const result = reviewSourceLifecycle({
    file,
    performances,
    epochId,
    nowIso,
    thresholds: thresholdsFromConfig(config),
    capacity: config.twitter.managed_list.capacity,
  })

  const reportBase: SourceListReviewReport = {
    epochId,
    scoreCutoff,
    applied: result.applied.length,
    queued: result.queued.length,
    pending: result.file.pendingTransitionIds.length,
    managed: result.file.candidates.filter((c) => c.status === "managed").length,
    candidates: result.file.candidates.length,
    transitions: result.dryRunWouldApply.map((t) => ({
      handle: t.handle,
      action: t.action,
      reasonCode: t.reasonCode,
    })),
  }

  if (opts.dryRun) return reportBase

  await state.saveSourceLifecycle(result.file)

  // Lagged scores into sources.json for candidates with settled call outcomes
  const writer = new SourceWriter(state)
  for (const candidate of result.file.candidates) {
    const perf = performances.get(candidate.sourceId)
    if (!perf || perf.settledCalls <= 0) continue
    await writer.upsertNeutralSource({
      sourceId: candidate.sourceId,
      handle: candidate.handle,
      platform: "x",
    })
    await writer.applyLaggedScore({
      sourceId: candidate.sourceId,
      score: perf.score,
      scoreUpdatedAt: scoreCutoff,
    })
  }

  const archiveDir = join(opts.archiveRoot, "source-lifecycle", epochId)
  mkdirSync(archiveDir, { recursive: true })
  writeFileSync(
    join(archiveDir, "review.json"),
    `${JSON.stringify({
      epochId,
      scoreCutoff,
      applied: result.applied,
      queued: result.queued,
      desired: desiredManagedHandles(result.file),
      sealedXCallers: callerIngest.report,
    }, null, 2)}\n`,
  )

  let syncReceipt: XListSyncReceipt | undefined
  if (opts.sync !== false && config.twitter.managed_list.list_id) {
    const sync = await syncManagedListMembership({
      managedListId: config.twitter.managed_list.list_id,
      desiredHandles: desiredManagedHandles(result.file),
      maxTransitions: config.twitter.source_lifecycle.max_transitions_per_review,
      nowIso,
    })
    syncReceipt = sync.receipt
    writeFileSync(
      join(archiveDir, "sync-receipt.json"),
      `${JSON.stringify(sync.receipt, null, 2)}\n`,
    )
    if (sync.receipt.verified && !sync.receipt.ambiguous) {
      const cleared = {
        ...result.file,
        pendingTransitionIds: result.file.pendingTransitionIds.filter((id) => (
          !result.applied.some((t) => t.transitionId === id)
        )),
      }
      await state.saveSourceLifecycle(cleared)
    }
  }

  return {
    ...reportBase,
    ...(syncReceipt ? { sync: syncReceipt } : {}),
  }
}

export async function syncPendingSourceList(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  nowIso?: string
}>): Promise<XListSyncReceipt> {
  const config = loadConfig()
  const listId = config.twitter.managed_list.list_id
  if (!listId) throw new Error("No managed list id — run: tc auth twitter --create-managed-list")
  const state = new StateStore(join(args.agentRoot, "state"))
  const file = state.loadSourceLifecycle()
  confineListId(listId, file.managedListId ?? listId)
  const nowIso = args.nowIso ?? systemClock.nowIso()
  const sync = await syncManagedListMembership({
    managedListId: listId,
    desiredHandles: desiredManagedHandles(file),
    maxTransitions: config.twitter.source_lifecycle.max_transitions_per_review,
    nowIso,
  })
  const archiveDir = join(args.archiveRoot, "source-lifecycle", `sync-${nowIso.slice(0, 19)}`)
  mkdirSync(archiveDir, { recursive: true })
  writeFileSync(join(archiveDir, "sync-receipt.json"), `${JSON.stringify(sync.receipt, null, 2)}\n`)
  if (sync.receipt.verified && !sync.receipt.ambiguous) {
    await state.saveSourceLifecycle({
      ...file,
      pendingTransitionIds: [],
    })
  }
  return sync.receipt
}

export async function createAndPersistManagedList(): Promise<{ listId: string, listUrl: string }> {
  const config = loadConfig()
  if (config.twitter.managed_list.list_id) {
    throw new Error(
      `Managed list already exists: ${config.twitter.managed_list.list_id} (${config.twitter.managed_list.list_url})`,
    )
  }
  const identity = await createManagedPrivateList({
    name: config.twitter.managed_list.name,
    description: config.twitter.managed_list.description,
    headless: false,
  })
  await saveConfig({
    ...config,
    twitter: {
      ...config.twitter,
      managed_list: {
        ...config.twitter.managed_list,
        list_id: identity.listId,
        list_url: identity.listUrl,
      },
    },
  })

  const agentRoot = existsSync(join(process.env["HOME"] ?? "", ".trenchcoat", "agent"))
    ? join(process.env["HOME"]!, ".trenchcoat", "agent")
    : join(process.cwd(), "agent")
  const state = new StateStore(join(agentRoot, "state"))
  const file = state.loadSourceLifecycle()
  await state.saveSourceLifecycle({
    ...file,
    managedListId: identity.listId,
    managedListUrl: identity.listUrl,
  })
  return identity
}

export function probeSourceListSummary(agentRoot: string, config: TrenchcoatConfig): unknown {
  const state = new StateStore(join(agentRoot, "state"))
  const file = state.loadSourceLifecycle()
  const managed = file.candidates.filter((c) => c.status === "managed")
  const probation = file.candidates.filter((c) => c.status === "probation")
  const demoted = file.candidates.filter((c) => c.status === "demoted")
  return {
    operatorLists: config.twitter.operator_list_urls,
    managedList: {
      id: config.twitter.managed_list.list_id ?? null,
      url: config.twitter.managed_list.list_url ?? null,
      capacity: config.twitter.managed_list.capacity,
      stateId: file.managedListId ?? null,
      drift: Boolean(
        config.twitter.managed_list.list_id
        && file.managedListId
        && config.twitter.managed_list.list_id !== file.managedListId,
      ),
    },
    candidates: {
      total: file.candidates.length,
      managed: managed.length,
      probation: probation.length,
      demoted: demoted.length,
    },
    pendingTransitions: file.pendingTransitionIds.length,
    transitionHistory: file.transitions.length,
    desiredHandlesHash: sha256Json(desiredManagedHandles(file)),
  }
}

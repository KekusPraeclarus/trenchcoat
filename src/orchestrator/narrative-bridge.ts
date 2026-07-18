import { join } from "node:path"
import { type ResearchQueueEntry } from "../contracts/schemas.js"
import { writeJsonRecordFsync, archiveLayout, runArchiveDir } from "../lib/archive.js"
import { loadConfig } from "../lib/config.js"
import { extractNarrativeTickers } from "../lib/narrative-tickers.js"
import { enqueueResearch } from "../lib/research-queue.js"
import { StateStore } from "../lib/state.js"
import { resolveResearchSubject, type ResolveSubjectResult } from "./research-collect.js"
import type { NarrativeLogEntry } from "./narrative-log.js"

const MAX_SYMBOLS_PER_RUN = 10

export type NarrativeBridgeItem = Readonly<{
  slug: string
  symbol: string
  status: ResearchQueueEntry["status"] | "skipped"
  reason: string
}>

export type NarrativeBridgeReport = Readonly<{
  schema: 1
  runId: string
  bridgedAt: string
  triggerSlugs: string[]
  consideredSymbols: number
  enqueued: number
  skippedWatchlist: number
  capped: number
  items: NarrativeBridgeItem[]
}>

function expiryIso(nowIso: string, days: number): string {
  return new Date(Date.parse(nowIso) + days * 86_400_000).toISOString()
}

function triggeredNarratives(
  before: readonly NarrativeLogEntry[],
  after: readonly NarrativeLogEntry[],
): NarrativeLogEntry[] {
  const priorBySlug = new Map(before.map((entry) => [entry.slug, entry]))
  return after
    .filter((entry) => {
      const prior = priorBySlug.get(entry.slug)
      return !prior || (prior.stage !== "peaking" && entry.stage === "peaking")
    })
    .sort((a, b) => a.slug.localeCompare(b.slug))
}

function isTrackedOrWatching(state: StateStore, symbol: string): boolean {
  return state.loadWatchlist().entries.some((entry) => (
    (entry.status === "tracking" || entry.status === "watching")
    && entry.identity.symbolDisplay.toLowerCase() === symbol.toLowerCase()
  ))
}

function shortlistReason(result: Extract<ResolveSubjectResult, { status: "ambiguous" }>): string {
  const shortlist = result.shortlist
    .slice(0, 4)
    .map((identity) => `${identity.chain}:${identity.tokenAddress}`)
    .join(",")
  return `narrative ticker ambiguous; shortlist=${shortlist}`.slice(0, 280)
}

function queueEntry(
  slug: string,
  symbol: string,
  nowIso: string,
  expiryDays: number,
  result: ResolveSubjectResult,
  evidence: readonly string[],
): ResearchQueueEntry {
  const base: ResearchQueueEntry = {
    schema: 1,
    queueId: `rq-narrative-${slug}-${symbol.toLowerCase()}`,
    subject: symbol,
    priority: 55,
    firstSeen: nowIso,
    enqueuedAt: nowIso,
    enqueuedBy: `narrative:${slug}`,
    trigger: "narrative",
    expiresAt: expiryIso(nowIso, expiryDays),
    provenance: [`narrative:${slug}`, ...evidence].slice(0, 32),
    clusterCount: 1,
    security: { status: "pending", flags: [] },
    status: "pending",
    resolution: "pending",
    reason: `narrative trigger: ${slug}`.slice(0, 280),
  }

  if (result.status === "resolved") {
    return {
      ...base,
      chain: result.identity.chain,
      tokenAddress: result.identity.tokenAddress,
      pairAddress: result.identity.pairAddress,
      symbolDisplay: result.identity.symbolDisplay,
      resolution: result.identity.resolution,
    }
  }
  if (result.status === "ambiguous") {
    return {
      ...base,
      status: "ambiguous",
      resolution: "ambiguous",
      reason: shortlistReason(result),
    }
  }
  if (result.status === "unsupported-chain") {
    return {
      ...base,
      status: "rejected",
      resolution: "unsupported-chain",
      reason: `unsupported chain: ${result.chain}`.slice(0, 280),
    }
  }
  return {
    ...base,
    status: "rejected",
    reason: "narrative ticker had no supported market candidate",
  }
}

export async function bridgeNarrativeTickers(args: {
  agentRoot: string
  archiveRoot?: string
  runId: string
  nowIso: string
  logBefore: readonly NarrativeLogEntry[]
  logAfter: readonly NarrativeLogEntry[]
  fetcher?: typeof fetch
}): Promise<NarrativeBridgeReport> {
  const config = loadConfig()
  const state = new StateStore(join(args.agentRoot, "state"))
  const triggerNarratives = triggeredNarratives(args.logBefore, args.logAfter)
  const candidates = triggerNarratives.flatMap((entry) => (
    extractNarrativeTickers(entry).map((symbol) => ({ entry, symbol }))
  )).slice(0, MAX_SYMBOLS_PER_RUN)
  const capped = Math.max(
    0,
    triggerNarratives.reduce((count, entry) => count + extractNarrativeTickers(entry).length, 0)
      - candidates.length,
  )
  let queue = state.loadResearchQueue()
  const items: NarrativeBridgeItem[] = []
  let enqueued = 0
  let skippedWatchlist = 0

  for (const { entry, symbol } of candidates) {
    if (isTrackedOrWatching(state, symbol)) {
      skippedWatchlist += 1
      items.push({
        slug: entry.slug,
        symbol,
        status: "skipped",
        reason: "already tracking or watching",
      })
      continue
    }
    let result: ResolveSubjectResult
    try {
      result = await resolveResearchSubject({ subject: symbol }, args.fetcher ?? fetch)
    } catch {
      result = { status: "empty" }
    }
    const next = queueEntry(
      entry.slug,
      symbol,
      args.nowIso,
      config.research.queue_expiry_days,
      result,
      entry.evidence,
    )
    queue = enqueueResearch(queue, next, config.research.daily_cap)
    enqueued += 1
    items.push({ slug: entry.slug, symbol, status: next.status, reason: next.reason })
  }
  await state.saveResearchQueue(queue)

  const report: NarrativeBridgeReport = {
    schema: 1,
    runId: args.runId,
    bridgedAt: args.nowIso,
    triggerSlugs: triggerNarratives.map((entry) => entry.slug),
    consideredSymbols: candidates.length,
    enqueued,
    skippedWatchlist,
    capped,
    items,
  }
  if (args.archiveRoot) {
    const layout = archiveLayout(args.archiveRoot)
    await writeJsonRecordFsync(
      join(runArchiveDir(layout, args.runId), "narrative-bridge.json"),
      report as never,
    )
  }
  return report
}

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  ensureArchive,
  runArchiveDir,
  transactionJournalPath,
  type ArchiveLayout,
} from "../lib/archive.js"
import { loadConfig, type TrenchcoatConfig } from "../lib/config.js"
import type { SnapshotWriter } from "../lib/snapshot.js"
import { StateStore } from "../lib/state.js"
import { RunManifestSchema } from "../contracts/schemas.js"
import { createJournalStore } from "./journal-store.js"
import { fetchFearGreed } from "../collectors/market/feargreed.js"

export type ReviewCollectResult = Readonly<{
  snapshotNames: readonly string[]
  postCount: number
  skipAgent: boolean
  collectionStatus: "completed" | "degraded" | "skipped"
  sealedReportCount: number
  pendingAlphaCount: number
  watchlistSubjects: number
}>

export type SealedRunRef = Readonly<{
  runId: string
  job: string
  createdAt: string
  reportPath: string
}>

export type ReviewPrerequisites = Readonly<{
  skipReason?: string
  sealedReports: readonly SealedRunRef[]
  pendingAlphaPaths: readonly string[]
  watchlistSubjects: number
}>

function parseJournalStatus(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const status = Reflect.get(raw, "status")
  const phase = Reflect.get(raw, "phase")
  if (status === "complete" || status === "failed" || status === "running") return status
  if (phase === "complete") return "complete"
  return undefined
}

function reviewConfigFromArgs(args: Readonly<{
  lookbackDays?: number
  maxReports?: number
  config?: TrenchcoatConfig
}>): { lookback_days: number; max_reports: number } {
  if (args.lookbackDays !== undefined && args.maxReports !== undefined) {
    return { lookback_days: args.lookbackDays, max_reports: args.maxReports }
  }
  const cfg = args.config ?? loadConfig()
  return {
    lookback_days: args.lookbackDays ?? cfg.review.lookback_days,
    max_reports: args.maxReports ?? cfg.review.max_reports,
  }
}

function reportPathForRun(runId: string): string {
  return `reports/${runId}/agent.md`
}

function withinLookback(createdAt: string, lookbackDays: number, nowIso: string): boolean {
  const cutoff = Date.parse(nowIso) - lookbackDays * 86_400_000
  return Date.parse(createdAt) >= cutoff
}

export async function listSealedCompletedReports(args: Readonly<{
  layout: ArchiveLayout
  agentRoot: string
  lookbackDays: number
  maxReports: number
  nowIso: string
}>): Promise<SealedRunRef[]> {
  if (!existsSync(args.layout.transactions)) return []
  const store = createJournalStore(args.layout)
  const matches: SealedRunRef[] = []

  for (const name of readdirSync(args.layout.transactions)) {
    if (!name.endsWith(".json")) continue
    const runId = name.slice(0, -".json".length)
    let journal: unknown
    try {
      journal = JSON.parse(readFileSync(transactionJournalPath(args.layout, runId), "utf8"))
    } catch {
      continue
    }
    if (parseJournalStatus(journal) !== "complete") continue
    const loaded = await store.load(runId)
    if (!loaded || loaded.status !== "complete") continue

    const manifestPath = join(runArchiveDir(args.layout, runId), "manifest.json")
    if (!existsSync(manifestPath)) continue
    let manifest
    try {
      manifest = RunManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")))
    } catch {
      continue
    }
    if (!withinLookback(manifest.createdAt, args.lookbackDays, args.nowIso)) continue

    const reportPath = reportPathForRun(runId)
    if (!existsSync(join(args.agentRoot, reportPath))) continue

    matches.push({
      runId,
      job: manifest.job,
      createdAt: manifest.createdAt,
      reportPath,
    })
  }

  return matches
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, args.maxReports)
}

export function listPendingAlphaPaths(agentRoot: string): string[] {
  const queueRoot = join(agentRoot, "alpha-queue")
  if (!existsSync(queueRoot)) return []
  const paths: string[] = []
  for (const channel of readdirSync(queueRoot).sort()) {
    const channelDir = join(queueRoot, channel)
    try {
      if (!statSync(channelDir).isDirectory()) continue
    } catch {
      continue
    }
    for (const file of readdirSync(channelDir).sort()) {
      if (!file.endsWith(".json")) continue
      paths.push(`alpha-queue/${channel}/${file}`)
    }
  }
  return paths
}

export function countWatchlistScope(agentRoot: string): number {
  const state = new StateStore(join(agentRoot, "state"))
  return state.loadWatchlist().entries.filter((entry) => (
    entry.status === "tracking" || entry.status === "watching"
  )).length
}

export async function evaluateReviewPrerequisites(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  nowIso: string
  lookbackDays?: number
  maxReports?: number
  config?: TrenchcoatConfig
}>): Promise<ReviewPrerequisites> {
  const reviewCfg = reviewConfigFromArgs(args)
  const layout = await ensureArchive(args.archiveRoot)
  const sealedReports = await listSealedCompletedReports({
    layout,
    agentRoot: args.agentRoot,
    lookbackDays: reviewCfg.lookback_days,
    maxReports: reviewCfg.max_reports,
    nowIso: args.nowIso,
  })
  const pendingAlphaPaths = listPendingAlphaPaths(args.agentRoot)
  const watchlistSubjects = countWatchlistScope(args.agentRoot)

  const skipReason = sealedReports.length === 0
    && pendingAlphaPaths.length === 0
    && watchlistSubjects === 0
    ? "no-review-scope"
    : undefined

  return {
    ...(skipReason ? { skipReason } : {}),
    sealedReports,
    pendingAlphaPaths,
    watchlistSubjects,
  }
}

export function hashResearchDir(agentRoot: string): string {
  const root = join(agentRoot, "state", "research")
  if (!existsSync(root)) return ""
  const parts: string[] = []
  for (const name of readdirSync(root).sort()) {
    if (!name.endsWith(".md")) continue
    const path = join(root, name)
    try {
      const st = statSync(path)
      if (st.isFile()) parts.push(`${name}:${st.size}:${Math.trunc(st.mtimeMs)}`)
    } catch {
      continue
    }
  }
  return parts.join("\n")
}

async function writeManifestSnapshot(
  args: Readonly<{
    runId: string
    writer: SnapshotWriter
    fetchedAt: string
    name: string
    lines: readonly string[]
  }>,
): Promise<void> {
  await args.writer.writeInbox(args.runId, args.name, {
    source: "host.review-collector",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: args.lines.map((text, index) => ({
      provenance: `${args.runId}:${args.name}:${index}`,
      text,
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live" as const,
    })),
  })
}

export async function collectReview(args: Readonly<{
  runId: string
  writer: SnapshotWriter
  fetchedAt: string
  agentRoot: string
  archiveRoot: string
  fetcher?: typeof fetch
}>): Promise<ReviewCollectResult> {
  let reviewCfg: { lookback_days: number; max_reports: number }
  try {
    reviewCfg = reviewConfigFromArgs({ config: loadConfig() })
  } catch {
    reviewCfg = { lookback_days: 7, max_reports: 30 }
  }
  const prereqs = await evaluateReviewPrerequisites({
    agentRoot: args.agentRoot,
    archiveRoot: args.archiveRoot,
    nowIso: args.fetchedAt,
    lookbackDays: reviewCfg.lookback_days,
    maxReports: reviewCfg.max_reports,
  })

  if (prereqs.skipReason) {
    await writeManifestSnapshot({
      runId: args.runId,
      writer: args.writer,
      fetchedAt: args.fetchedAt,
      name: "collection-status",
      lines: [`job=review status=skipped reason=${prereqs.skipReason}`],
    })
    return {
      snapshotNames: ["collection-status"],
      postCount: 1,
      skipAgent: true,
      collectionStatus: "skipped",
      sealedReportCount: 0,
      pendingAlphaCount: 0,
      watchlistSubjects: 0,
    }
  }

  const snapshotNames: string[] = []
  const statusLines: string[] = [
    `job=review status=completed`,
    `lookbackDays=${reviewCfg.lookback_days}`,
    `maxReports=${reviewCfg.max_reports}`,
    `sealedReports=${prereqs.sealedReports.length}`,
    `pendingAlpha=${prereqs.pendingAlphaPaths.length}`,
    `watchlistSubjects=${prereqs.watchlistSubjects}`,
  ]

  const reportLines = prereqs.sealedReports.map((ref) => (
    `runId=${ref.runId} job=${ref.job} createdAt=${ref.createdAt} path=${ref.reportPath}`
  ))
  await writeManifestSnapshot({
    runId: args.runId,
    writer: args.writer,
    fetchedAt: args.fetchedAt,
    name: "review-reports-manifest",
    lines: reportLines.length > 0 ? reportLines : ["reports=(none)"],
  })
  snapshotNames.push("review-reports-manifest")

  const alphaLines = prereqs.pendingAlphaPaths.map((path) => `path=${path}`)
  await writeManifestSnapshot({
    runId: args.runId,
    writer: args.writer,
    fetchedAt: args.fetchedAt,
    name: "review-alpha-manifest",
    lines: alphaLines.length > 0 ? alphaLines : ["pendingAlpha=(none)"],
  })
  snapshotNames.push("review-alpha-manifest")

  const state = new StateStore(join(args.agentRoot, "state"))
  const watchlist = state.loadWatchlist()
  const active = watchlist.entries.filter((entry) => (
    entry.status === "tracking" || entry.status === "watching"
  ))
  const watchlistLines = active.slice(0, 30).map((entry) => (
    [
      `symbol=${entry.identity.symbolDisplay}`,
      `chain=${entry.identity.chain}`,
      `token=${entry.identity.tokenAddress}`,
      `status=${entry.status}`,
      `research=state/research/${entry.identity.symbolDisplay}.md`,
    ].join(" ")
  ))
  if (active.length > 30) {
    watchlistLines.push(`truncated=${active.length - 30}`)
  }
  await writeManifestSnapshot({
    runId: args.runId,
    writer: args.writer,
    fetchedAt: args.fetchedAt,
    name: "review-watchlist-snapshot",
    lines: watchlistLines.length > 0 ? watchlistLines : ["watchlist=(empty)"],
  })
  snapshotNames.push("review-watchlist-snapshot")

  let macroStatus = "ok"
  try {
    const macro = await fetchFearGreed(args.fetcher ?? fetch)
    await writeManifestSnapshot({
      runId: args.runId,
      writer: args.writer,
      fetchedAt: args.fetchedAt,
      name: "review-macro-snapshot",
      lines: [
        `fearGreed=${macro.value}`,
        `classification=${macro.classification}`,
        `timestamp=${new Date(macro.timestamp).toISOString()}`,
      ],
    })
    snapshotNames.push("review-macro-snapshot")
  } catch {
    macroStatus = "unavailable"
    await writeManifestSnapshot({
      runId: args.runId,
      writer: args.writer,
      fetchedAt: args.fetchedAt,
      name: "review-macro-snapshot",
      lines: ["macro=fear-greed status=unavailable"],
    })
    snapshotNames.push("review-macro-snapshot")
  }
  statusLines.push(`macro=${macroStatus}`)

  await writeManifestSnapshot({
    runId: args.runId,
    writer: args.writer,
    fetchedAt: args.fetchedAt,
    name: "collection-status",
    lines: statusLines,
  })
  snapshotNames.push("collection-status")

  return {
    snapshotNames,
    postCount: snapshotNames.length,
    skipAgent: false,
    collectionStatus: macroStatus === "ok" ? "completed" : "degraded",
    sealedReportCount: prereqs.sealedReports.length,
    pendingAlphaCount: prereqs.pendingAlphaPaths.length,
    watchlistSubjects: prereqs.watchlistSubjects,
  }
}

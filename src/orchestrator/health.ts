import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ensureArchive,
  runArchiveDir,
  type ArchiveLayout,
} from "../lib/archive.js"
import { agentLockPath } from "../lib/lock.js"
import { loadConfig } from "../lib/config.js"
import { loadDeploymentManifest, DEPLOYMENT_CONFIG_SCHEMA } from "../lib/deployment.js"
import { StateStore } from "../lib/state.js"
import { RunManifestSchema } from "../contracts/schemas.js"
import { loadJournalForScan } from "./journal-store.js"
import { findIncompleteRunRefs, type IncompleteRunRef } from "./resume.js"
import {
  snapshotBroadcastPipeline,
  type BroadcastPipelineSnapshot,
} from "./delivery.js"
import type { JobName } from "./jobs.js"
import {
  X_BOT_HEALTH_ESCALATION_THRESHOLD,
  xBotHealthEscalation,
} from "./x-bot-health.js"

export const HEALTH_SNAPSHOT_SCHEMA = 1 as const

/** Jobs surfaced in status/review; cadence ages are advisory only.
 * Narrative freshness is lastSuccess age for narrative-scan from sealed
 * complete journals — never inferred from INDEX.md line dates. */
export const KEY_HEALTH_JOBS: readonly JobName[] = Object.freeze([
  "list-scan",
  "farcaster-scan",
  "narrative-scan",
  "research",
  "review",
  "chart-sweep",
  "watchlist-scan",
  "delivery-retry",
  "wallet-discovery",
  "wallet-scan-solana",
  "wallet-scan-evm",
  "wallet-review",
  "outcomes-settle",
  "source-list-review",
  "fc-source-review",
])

const MAX_SKIP_LINES_PER_JOB = 500
const MAX_FC_RECEIPT_SCAN = 12
const MAX_JSON_SKIP_REASONS = 40
const MAX_TEXT_WARNINGS = 24
const MAX_TEXT_JOBS = 16

export type JobOutcomeKind = "success" | "failure" | "skip" | "collector-skip"

export type JobLastOutcome = Readonly<{
  kind: JobOutcomeKind
  at: string
  ageMs: number
  runId?: string
  reason?: string
}>

export type JobHealth = Readonly<{
  job: JobName
  lastSuccess?: JobLastOutcome
  lastFailure?: JobLastOutcome
  lastSkip?: JobLastOutcome
  lastCollectorSkip?: JobLastOutcome
}>

export type HealthLockState = Readonly<{
  held: boolean
  pid?: number
  alive?: boolean
  stale?: boolean
}>

export type HealthResearchDepth = Readonly<{
  actionable: number
  ambiguous: number
  researching: number
  pending: number
  total: number
}>

export type HealthWatchlistCounts = Readonly<{
  active: number
  total: number
}>

export type HealthWalletCounts = Readonly<{
  tracking: number
  candidate: number
  probation: number
  total: number
  silent: boolean
}>

export type HealthXState = Readonly<{
  pendingActions: number
  consecutiveFailures: number
  blocked: boolean
  lastVerifiedAt?: string
}>

export type HealthFarcasterState = Readonly<{
  recentRuns: number
  staleStreak: number
  lastFallbackUsed?: boolean
  lastUsableEvidence?: number
  lastRejectReason?: string
  lastAt?: string
}>

export type HealthDeploymentState = Readonly<{
  configSchema?: number
  expectedSchema: number
  manifestPresent: boolean
  manifestConfigSchema?: number
  schemaMismatch: boolean
  sourceCommit?: string | null
  sourceDirty?: boolean
  sourceHash?: string
  packageVersion?: string
}>

export type HealthFomoState = Readonly<{
  enabled: boolean
  shadowMode: boolean
  /** FOMO never certifies legacy research/wallet health */
  parallelOnly: true
}>

export type HealthSnapshot = Readonly<{
  schema: typeof HEALTH_SNAPSHOT_SCHEMA
  capturedAt: string
  lock: HealthLockState
  incompleteRuns: readonly IncompleteRunRef[]
  jobs: readonly JobHealth[]
  skipReasons: Readonly<Record<string, Readonly<Record<string, number>>>>
  research: HealthResearchDepth
  watchlist: HealthWatchlistCounts
  wallets: HealthWalletCounts
  x: HealthXState
  farcaster: HealthFarcasterState
  router: BroadcastPipelineSnapshot
  deployment: HealthDeploymentState
  fomo: HealthFomoState
  warnings: readonly string[]
}>

function ageMs(at: string, nowMs: number): number {
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return 0
  return Math.max(0, nowMs - t)
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}

function readLockState(agentRoot: string): HealthLockState {
  const ownerPath = `${agentLockPath(agentRoot)}.owner`
  if (!existsSync(ownerPath)) return { held: false }
  const pid = Number(readFileSync(ownerPath, "utf8").trim())
  if (!Number.isInteger(pid) || pid <= 0) {
    return { held: true, stale: true }
  }
  let alive = false
  try {
    process.kill(pid, 0)
    alive = true
  } catch {
    alive = false
  }
  return {
    held: true,
    pid,
    alive,
    stale: !alive,
  }
}

function newerOutcome(
  a: JobLastOutcome | undefined,
  b: JobLastOutcome,
): JobLastOutcome {
  if (!a) return b
  return Date.parse(b.at) >= Date.parse(a.at) ? b : a
}

type SkipLedgerLine = Readonly<{
  job?: string
  reason?: string
  skippedAt?: string
}>

function readSkipLedgers(archiveRoot: string, nowMs: number): {
  counts: Record<string, Record<string, number>>
  lastSkipByJob: Map<JobName, JobLastOutcome>
} {
  const counts: Record<string, Record<string, number>> = {}
  const lastSkipByJob = new Map<JobName, JobLastOutcome>()
  const skipsDir = join(archiveRoot, "skips")
  if (!existsSync(skipsDir)) return { counts, lastSkipByJob }

  for (const name of readdirSync(skipsDir)) {
    if (!name.endsWith(".jsonl")) continue
    const job = name.slice(0, -".jsonl".length) as JobName
    const path = join(skipsDir, name)
    let body: string
    try {
      body = readFileSync(path, "utf8")
    } catch {
      continue
    }
    const lines = body.split("\n").filter(Boolean).slice(-MAX_SKIP_LINES_PER_JOB)
    for (const line of lines) {
      let parsed: SkipLedgerLine
      try {
        parsed = JSON.parse(line) as SkipLedgerLine
      } catch {
        continue
      }
      const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 64) : "unknown"
      const jobKey = typeof parsed.job === "string" ? parsed.job : job
      counts[jobKey] ??= {}
      counts[jobKey]![reason] = (counts[jobKey]![reason] ?? 0) + 1
      if (typeof parsed.skippedAt === "string" && KEY_HEALTH_JOBS.includes(job)) {
        lastSkipByJob.set(job, newerOutcome(lastSkipByJob.get(job), {
          kind: "skip",
          at: parsed.skippedAt,
          ageMs: ageMs(parsed.skippedAt, nowMs),
          reason,
        }))
      }
    }
  }
  return { counts, lastSkipByJob }
}

function isCollectorSkip(agentRoot: string, runId: string): boolean {
  return existsSync(join(agentRoot, "reports", runId, "collector-skip.json"))
}

async function scanJobOutcomes(args: Readonly<{
  layout: ArchiveLayout
  agentRoot: string
  nowMs: number
}>): Promise<Map<JobName, {
  lastSuccess?: JobLastOutcome
  lastFailure?: JobLastOutcome
  lastCollectorSkip?: JobLastOutcome
}>> {
  const byJob = new Map<JobName, {
    lastSuccess?: JobLastOutcome
    lastFailure?: JobLastOutcome
    lastCollectorSkip?: JobLastOutcome
  }>()
  if (!existsSync(args.layout.transactions)) return byJob

  for (const name of readdirSync(args.layout.transactions)) {
    if (!name.endsWith(".json")) continue
    const runId = name.slice(0, -".json".length)
    const loaded = await loadJournalForScan(args.layout, runId)
    if (!loaded) continue
    if (loaded.status !== "complete" && loaded.status !== "failed") continue

    const manifestPath = join(runArchiveDir(args.layout, runId), "manifest.json")
    if (!existsSync(manifestPath)) continue
    let manifest
    try {
      manifest = RunManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")))
    } catch {
      continue
    }
    const job = manifest.job as JobName
    if (!KEY_HEALTH_JOBS.includes(job)) continue

    const at = manifest.createdAt
    const outcomeBase = {
      at,
      ageMs: ageMs(at, args.nowMs),
      runId,
    }
    const slot = byJob.get(job) ?? {}
    if (loaded.status === "failed") {
      slot.lastFailure = newerOutcome(slot.lastFailure, {
        kind: "failure",
        ...outcomeBase,
        ...(loaded.failure?.code ? { reason: loaded.failure.code } : {}),
      })
    } else if (isCollectorSkip(args.agentRoot, runId)) {
      slot.lastCollectorSkip = newerOutcome(slot.lastCollectorSkip, {
        kind: "collector-skip",
        ...outcomeBase,
      })
    } else {
      slot.lastSuccess = newerOutcome(slot.lastSuccess, {
        kind: "success",
        ...outcomeBase,
      })
    }
    byJob.set(job, slot)
  }
  return byJob
}

type FcReceiptSummary = Readonly<{
  at: string
  fallbackUsed: boolean
  usableEvidenceCount: number
  stale: boolean
  rejectReason?: string
}>

function parseFcReceiptText(text: string): {
  fallbackUsed: boolean
  usableEvidenceCount: number
  stale: boolean
  rejectReason?: string
} | undefined {
  try {
    const raw = JSON.parse(text) as {
      fallbackUsed?: unknown
      usableEvidenceCount?: unknown
      feeds?: Array<{ rejected?: boolean, rejectReason?: string, target?: { kind?: string } }>
    }
    const fallbackUsed = raw.fallbackUsed === true
    const usableEvidenceCount = typeof raw.usableEvidenceCount === "number"
      ? raw.usableEvidenceCount
      : 0
    const fyp = raw.feeds?.find((f) => f.target?.kind === "for_you")
    const rejectReason = typeof fyp?.rejectReason === "string"
      ? fyp.rejectReason.slice(0, 64)
      : undefined
    const stale = Boolean(
      rejectReason?.includes("stale")
      || rejectReason === "repeated_two_hash_stale"
      || (usableEvidenceCount === 0 && fallbackUsed),
    )
    return { fallbackUsed, usableEvidenceCount, stale, ...(rejectReason ? { rejectReason } : {}) }
  } catch {
    return undefined
  }
}

async function scanFarcasterHealth(args: Readonly<{
  layout: ArchiveLayout
  nowMs: number
}>): Promise<HealthFarcasterState> {
  if (!existsSync(args.layout.transactions)) {
    return { recentRuns: 0, staleStreak: 0 }
  }
  const candidates: Array<{ runId: string, createdAt: string }> = []
  for (const name of readdirSync(args.layout.transactions)) {
    if (!name.endsWith(".json")) continue
    const runId = name.slice(0, -".json".length)
    const loaded = await loadJournalForScan(args.layout, runId)
    if (!loaded || loaded.status !== "complete") continue
    const manifestPath = join(runArchiveDir(args.layout, runId), "manifest.json")
    if (!existsSync(manifestPath)) continue
    let manifest
    try {
      manifest = RunManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")))
    } catch {
      continue
    }
    if (manifest.job !== "farcaster-scan") continue
    candidates.push({ runId, createdAt: manifest.createdAt })
  }
  candidates.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))

  const summaries: FcReceiptSummary[] = []
  for (const candidate of candidates.slice(0, MAX_FC_RECEIPT_SCAN)) {
    const receiptPath = join(
      runArchiveDir(args.layout, candidate.runId),
      "inbox",
      "farcaster-collection-receipt.json",
    )
    if (!existsSync(receiptPath)) continue
    let envelope: { items?: Array<{ text?: string }> }
    try {
      envelope = JSON.parse(readFileSync(receiptPath, "utf8")) as typeof envelope
    } catch {
      continue
    }
    const text = envelope.items?.[0]?.text
    if (typeof text !== "string") continue
    const parsed = parseFcReceiptText(text)
    if (!parsed) continue
    summaries.push({ at: candidate.createdAt, ...parsed })
  }

  let staleStreak = 0
  for (const summary of summaries) {
    if (!summary.stale) break
    staleStreak += 1
  }
  const latest = summaries[0]
  return {
    recentRuns: summaries.length,
    staleStreak,
    ...(latest
      ? {
        lastFallbackUsed: latest.fallbackUsed,
        lastUsableEvidence: latest.usableEvidenceCount,
        ...(latest.rejectReason ? { lastRejectReason: latest.rejectReason } : {}),
        lastAt: latest.at,
      }
      : {}),
  }
}

function researchDepth(agentRoot: string): HealthResearchDepth {
  const state = new StateStore(join(agentRoot, "state"))
  const entries = state.loadResearchQueue().entries
  let actionable = 0
  let ambiguous = 0
  let researching = 0
  let pending = 0
  for (const entry of entries) {
    if (entry.status === "ambiguous") ambiguous += 1
    if (entry.status === "researching") researching += 1
    if (entry.status === "pending") {
      pending += 1
      // Ambiguous resolution is parked; only pending+runnable counts as actionable
      if (entry.resolution !== "ambiguous" && entry.resolution !== "unsupported-chain") {
        actionable += 1
      }
    }
  }
  return {
    actionable,
    ambiguous,
    researching,
    pending,
    total: entries.length,
  }
}

function watchlistCounts(agentRoot: string): HealthWatchlistCounts {
  const state = new StateStore(join(agentRoot, "state"))
  const entries = state.loadWatchlist().entries
  const active = entries.filter((e) => e.status === "tracking" || e.status === "watching").length
  return { active, total: entries.length }
}

function walletCounts(agentRoot: string): HealthWalletCounts {
  const state = new StateStore(join(agentRoot, "state"))
  const wallets = state.loadWallets().wallets
  let tracking = 0
  let candidate = 0
  let probation = 0
  for (const wallet of wallets) {
    if (wallet.status === "tracking") tracking += 1
    else if (wallet.status === "candidate") candidate += 1
    else if (wallet.status === "tracking-probation") probation += 1
  }
  const silent = tracking === 0 && candidate === 0 && probation === 0
  return {
    tracking,
    candidate,
    probation,
    total: wallets.length,
    silent,
  }
}

function xState(agentRoot: string, nowIso: string): HealthXState {
  const state = new StateStore(join(agentRoot, "state"))
  const engagement = state.loadXEngagement()
  const health = state.loadXBotHealth(nowIso)
  const escalation = xBotHealthEscalation(health)
  return {
    pendingActions: engagement.pendingActionIds.length,
    consecutiveFailures: health.consecutiveFailures,
    blocked: escalation.escalate,
    ...(health.lastVerifiedAction?.attemptedAt
      ? { lastVerifiedAt: health.lastVerifiedAction.attemptedAt }
      : {}),
  }
}

function deploymentState(): HealthDeploymentState {
  const expectedSchema = DEPLOYMENT_CONFIG_SCHEMA
  let configSchema: number | undefined
  try {
    configSchema = loadConfig().schema
  } catch {
    configSchema = undefined
  }
  const manifest = loadDeploymentManifest()
  const manifestConfigSchema = manifest?.configSchema
  const schemaMismatch = configSchema !== undefined
    && manifestConfigSchema !== undefined
    && configSchema !== manifestConfigSchema
  return {
    ...(configSchema !== undefined ? { configSchema } : {}),
    expectedSchema,
    manifestPresent: Boolean(manifest),
    ...(manifestConfigSchema !== undefined ? { manifestConfigSchema } : {}),
    schemaMismatch,
    ...(manifest
      ? {
        sourceCommit: manifest.sourceCommit,
        sourceDirty: manifest.sourceDirty,
        sourceHash: manifest.sourceHash,
        packageVersion: manifest.packageVersion,
      }
      : {}),
  }
}

function fomoState(): HealthFomoState {
  try {
    const cfg = loadConfig()
    return {
      enabled: cfg.fomo.enabled,
      shadowMode: cfg.fomo.shadow_mode,
      parallelOnly: true,
    }
  } catch {
    return { enabled: false, shadowMode: true, parallelOnly: true }
  }
}

function buildWarnings(snapshot: Omit<HealthSnapshot, "warnings">): string[] {
  const warnings: string[] = []
  if (snapshot.lock.stale) {
    warnings.push(`stale workspace lock pid=${snapshot.lock.pid ?? "unknown"}`)
  } else if (snapshot.lock.held) {
    warnings.push(`workspace lock held pid=${snapshot.lock.pid ?? "unknown"}`)
  }

  const abandoned = snapshot.incompleteRuns.filter((r) => r.status === "abandoned")
  const running = snapshot.incompleteRuns.filter((r) => r.status === "running")
  if (abandoned.length > 0) {
    warnings.push(`abandoned runs=${abandoned.length}`)
  }
  if (running.length > 0) {
    warnings.push(`incomplete runs=${running.length}`)
  }

  if (snapshot.research.actionable === 0) {
    warnings.push("research queue empty (no actionable entries)")
  }
  if (snapshot.research.ambiguous > 0) {
    warnings.push(`research ambiguous=${snapshot.research.ambiguous}`)
  }
  if (snapshot.watchlist.active === 0) {
    warnings.push("watchlist empty")
  }
  if (snapshot.wallets.silent) {
    warnings.push("wallets silent (no tracking/candidate/probation)")
  }
  if (snapshot.x.blocked) {
    warnings.push(
      `x bot health blocked consecutiveFailures=${snapshot.x.consecutiveFailures}`
        + ` threshold=${X_BOT_HEALTH_ESCALATION_THRESHOLD}`,
    )
  } else if (snapshot.x.pendingActions > 0) {
    warnings.push(`x pending actions=${snapshot.x.pendingActions}`)
  }
  if (snapshot.farcaster.staleStreak > 0) {
    warnings.push(
      `fc stale streak=${snapshot.farcaster.staleStreak}`
        + (snapshot.farcaster.lastFallbackUsed ? " fallbackUsed" : ""),
    )
  }
  if (snapshot.router.ingress.ingressPending > 0) {
    warnings.push(`router ingress pending=${snapshot.router.ingress.ingressPending}`)
  }
  if (snapshot.router.ingress.failed > 0) {
    warnings.push(`router ingress failed=${snapshot.router.ingress.failed}`)
  }
  if (!snapshot.deployment.manifestPresent) {
    warnings.push("deployment.json missing — re-run ops/install-launchd.sh")
  } else if (snapshot.deployment.schemaMismatch) {
    warnings.push(
      `config/runtime schema mismatch config=${snapshot.deployment.configSchema}`
        + ` runtime=${snapshot.deployment.manifestConfigSchema}`,
    )
  }
  if (snapshot.deployment.sourceDirty === true) {
    warnings.push(
      "deployment source dirty — runtime built with --allow-dirty"
        + (snapshot.deployment.sourceHash
          ? ` sourceHash=${snapshot.deployment.sourceHash.slice(0, 19)}`
          : ""),
    )
  }
  if (snapshot.deployment.configSchema !== undefined
    && snapshot.deployment.configSchema !== snapshot.deployment.expectedSchema
  ) {
    warnings.push(
      `config schema ${snapshot.deployment.configSchema} != expected ${snapshot.deployment.expectedSchema}`,
    )
  }

  let recurringSkips = 0
  for (const reasons of Object.values(snapshot.skipReasons)) {
    for (const count of Object.values(reasons)) {
      if (count >= 3) recurringSkips += 1
    }
  }
  if (recurringSkips > 0) {
    warnings.push(`recurring skip reasons=${recurringSkips}`)
  }

  return warnings.slice(0, 64)
}

/** Health findings that keep daily review in scope without agent report dirs */
export function healthCreatesReviewScope(snapshot: HealthSnapshot): boolean {
  if (snapshot.warnings.length > 0) return true
  if (snapshot.incompleteRuns.length > 0) return true
  if (Object.keys(snapshot.skipReasons).length > 0) return true
  if (snapshot.research.ambiguous > 0 || snapshot.research.actionable === 0) return true
  if (snapshot.wallets.silent) return true
  if (snapshot.farcaster.staleStreak > 0) return true
  if (snapshot.router.ingress.ingressPending > 0 || snapshot.router.ingress.failed > 0) return true
  return false
}

export async function buildHealthSnapshot(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  nowIso?: string
  layout?: ArchiveLayout
}>): Promise<HealthSnapshot> {
  const capturedAt = args.nowIso ?? new Date().toISOString()
  const nowMs = Date.parse(capturedAt)
  const layout = args.layout ?? await ensureArchive(args.archiveRoot)

  const lock = readLockState(args.agentRoot)
  const incompleteRuns = await findIncompleteRunRefs(layout, capturedAt)
  const { counts: skipReasons, lastSkipByJob } = readSkipLedgers(args.archiveRoot, nowMs)
  const outcomes = await scanJobOutcomes({
    layout,
    agentRoot: args.agentRoot,
    nowMs,
  })

  const jobs: JobHealth[] = KEY_HEALTH_JOBS.map((job) => {
    const scanned = outcomes.get(job) ?? {}
    const lastSkip = lastSkipByJob.get(job)
    return {
      job,
      ...(scanned.lastSuccess ? { lastSuccess: scanned.lastSuccess } : {}),
      ...(scanned.lastFailure ? { lastFailure: scanned.lastFailure } : {}),
      ...(lastSkip ? { lastSkip } : {}),
      ...(scanned.lastCollectorSkip ? { lastCollectorSkip: scanned.lastCollectorSkip } : {}),
    }
  })

  const research = existsSync(join(args.agentRoot, "state"))
    ? researchDepth(args.agentRoot)
    : { actionable: 0, ambiguous: 0, researching: 0, pending: 0, total: 0 }
  const watchlist = existsSync(join(args.agentRoot, "state"))
    ? watchlistCounts(args.agentRoot)
    : { active: 0, total: 0 }
  const wallets = existsSync(join(args.agentRoot, "state"))
    ? walletCounts(args.agentRoot)
    : { tracking: 0, candidate: 0, probation: 0, total: 0, silent: true }
  const x = existsSync(join(args.agentRoot, "state"))
    ? xState(args.agentRoot, capturedAt)
    : { pendingActions: 0, consecutiveFailures: 0, blocked: false }
  const farcaster = await scanFarcasterHealth({ layout, nowMs })
  const router = snapshotBroadcastPipeline(layout, capturedAt)
  const deployment = deploymentState()
  const fomo = fomoState()

  const base = {
    schema: HEALTH_SNAPSHOT_SCHEMA,
    capturedAt,
    lock,
    incompleteRuns,
    jobs,
    skipReasons,
    research,
    watchlist,
    wallets,
    x,
    farcaster,
    router,
    deployment,
    fomo,
  }
  return {
    ...base,
    warnings: buildWarnings(base),
  }
}

function outcomeLine(label: string, outcome: JobLastOutcome | undefined): string | undefined {
  if (!outcome) return undefined
  const bits = [
    `${label}=${outcome.kind}`,
    `age=${formatAge(outcome.ageMs)}`,
  ]
  if (outcome.runId) bits.push(`run=${outcome.runId}`)
  if (outcome.reason) bits.push(`reason=${outcome.reason}`)
  return bits.join(" ")
}

/** Human-readable multi-line summary for CLI and Telegram (no secrets). */
export function formatHealthText(snapshot: HealthSnapshot): string {
  const lines: string[] = [
    `trenchcoat health @ ${snapshot.capturedAt}`,
  ]

  if (snapshot.lock.held) {
    lines.push(
      `lock: held pid=${snapshot.lock.pid ?? "?"} alive=${snapshot.lock.alive === true}`
        + (snapshot.lock.stale ? " STALE" : ""),
    )
  } else {
    lines.push("lock: free")
  }

  const abandoned = snapshot.incompleteRuns.filter((r) => r.status === "abandoned").length
  const running = snapshot.incompleteRuns.filter((r) => r.status === "running").length
  lines.push(`runs: incomplete=${running} abandoned=${abandoned}`)

  lines.push(
    `research: actionable=${snapshot.research.actionable}`
      + ` ambiguous=${snapshot.research.ambiguous}`
      + ` researching=${snapshot.research.researching}`
      + ` total=${snapshot.research.total}`,
  )
  lines.push(`watchlist: active=${snapshot.watchlist.active} total=${snapshot.watchlist.total}`)
  lines.push(
    `wallets: tracking=${snapshot.wallets.tracking}`
      + ` candidate=${snapshot.wallets.candidate}`
      + ` probation=${snapshot.wallets.probation}`
      + (snapshot.wallets.silent ? " silent" : ""),
  )
  lines.push(
    `x: pending=${snapshot.x.pendingActions}`
      + ` failures=${snapshot.x.consecutiveFailures}`
      + (snapshot.x.blocked ? " BLOCKED" : ""),
  )
  lines.push(
    `fc: staleStreak=${snapshot.farcaster.staleStreak}`
      + ` recent=${snapshot.farcaster.recentRuns}`
      + (snapshot.farcaster.lastFallbackUsed ? " fallback" : "")
      + (snapshot.farcaster.lastRejectReason
        ? ` reject=${snapshot.farcaster.lastRejectReason}`
        : ""),
  )
  const ing = snapshot.router.ingress
  lines.push(
    `router: staged=${ing.staged} pending=${ing.ingressPending}`
      + ` failed=${ing.failed} accepted=${ing.accepted}`,
  )

  const dep = snapshot.deployment
  lines.push(
    `deploy: configSchema=${dep.configSchema ?? "?"} runtime=${dep.manifestPresent ? dep.manifestConfigSchema : "missing"}`
      + (dep.schemaMismatch ? " MISMATCH" : "")
      + (dep.sourceDirty ? " DIRTY" : "")
      + (dep.sourceCommit ? ` commit=${dep.sourceCommit.slice(0, 12)}` : "")
      + (dep.sourceHash ? ` src=${dep.sourceHash.slice(0, 19)}` : ""),
  )
  lines.push(
    `fomo: enabled=${snapshot.fomo.enabled} shadow=${snapshot.fomo.shadowMode} (parallel-only)`,
  )

  let jobLines = 0
  for (const job of snapshot.jobs) {
    if (jobLines >= MAX_TEXT_JOBS) {
      lines.push(`jobs: … +${snapshot.jobs.length - jobLines} more`)
      break
    }
    const parts = [
      outcomeLine("ok", job.lastSuccess),
      outcomeLine("fail", job.lastFailure),
      outcomeLine("skip", job.lastSkip),
      outcomeLine("collector", job.lastCollectorSkip),
    ].filter(Boolean)
    if (parts.length === 0) continue
    lines.push(`job ${job.job}: ${parts.join("; ")}`)
    jobLines += 1
  }

  const skipPairs: string[] = []
  for (const [job, reasons] of Object.entries(snapshot.skipReasons)) {
    for (const [reason, count] of Object.entries(reasons)) {
      skipPairs.push(`${job}/${reason}=${count}`)
    }
  }
  if (skipPairs.length > 0) {
    lines.push(`skips: ${skipPairs.slice(0, 12).join(" ")}`)
  }

  if (snapshot.warnings.length > 0) {
    lines.push("warnings:")
    for (const warning of snapshot.warnings.slice(0, MAX_TEXT_WARNINGS)) {
      lines.push(`  - ${warning}`)
    }
  } else {
    lines.push("warnings: none")
  }

  return lines.join("\n")
}

/** Bounded JSON-serializable payload for `tc status --json` — no secrets. */
export function toHealthJsonPayload(snapshot: HealthSnapshot): Readonly<Record<string, unknown>> {
  const skipReasons: Record<string, Record<string, number>> = {}
  let skipEntries = 0
  for (const [job, reasons] of Object.entries(snapshot.skipReasons)) {
    for (const [reason, count] of Object.entries(reasons)) {
      if (skipEntries >= MAX_JSON_SKIP_REASONS) break
      skipReasons[job] ??= {}
      skipReasons[job]![reason] = count
      skipEntries += 1
    }
    if (skipEntries >= MAX_JSON_SKIP_REASONS) break
  }

  return {
    schema: snapshot.schema,
    capturedAt: snapshot.capturedAt,
    lock: snapshot.lock,
    incompleteRuns: snapshot.incompleteRuns.slice(0, 32),
    jobs: snapshot.jobs,
    skipReasons,
    research: snapshot.research,
    watchlist: snapshot.watchlist,
    wallets: snapshot.wallets,
    x: snapshot.x,
    farcaster: snapshot.farcaster,
    router: snapshot.router,
    deployment: {
      ...snapshot.deployment,
      sourceCommit: snapshot.deployment.sourceCommit
        ? snapshot.deployment.sourceCommit.slice(0, 12)
        : snapshot.deployment.sourceCommit,
      sourceHash: snapshot.deployment.sourceHash
        ? snapshot.deployment.sourceHash.slice(0, 19)
        : snapshot.deployment.sourceHash,
    },
    fomo: snapshot.fomo,
    warnings: snapshot.warnings.slice(0, 64),
  }
}

export function formatHealthJson(snapshot: HealthSnapshot): string {
  return `${JSON.stringify(toHealthJsonPayload(snapshot), null, 2)}\n`
}

/** Compact inbox lines for daily review (path-only / counts — never secrets). */
export function healthSnapshotLines(snapshot: HealthSnapshot): string[] {
  const lines = [
    `capturedAt=${snapshot.capturedAt}`,
    `lockHeld=${snapshot.lock.held} lockStale=${snapshot.lock.stale === true}`,
    `incomplete=${snapshot.incompleteRuns.filter((r) => r.status === "running").length}`,
    `abandoned=${snapshot.incompleteRuns.filter((r) => r.status === "abandoned").length}`,
    `researchActionable=${snapshot.research.actionable} researchAmbiguous=${snapshot.research.ambiguous}`,
    `watchlistActive=${snapshot.watchlist.active}`,
    `walletsSilent=${snapshot.wallets.silent} walletsTracking=${snapshot.wallets.tracking}`,
    `xPending=${snapshot.x.pendingActions} xBlocked=${snapshot.x.blocked}`,
    `fcStaleStreak=${snapshot.farcaster.staleStreak} fcFallback=${snapshot.farcaster.lastFallbackUsed === true}`,
    `routerPending=${snapshot.router.ingress.ingressPending} routerFailed=${snapshot.router.ingress.failed}`,
    `deployManifest=${snapshot.deployment.manifestPresent} schemaMismatch=${snapshot.deployment.schemaMismatch}`
      + ` sourceDirty=${snapshot.deployment.sourceDirty === true}`,
    `fomoEnabled=${snapshot.fomo.enabled} fomoShadow=${snapshot.fomo.shadowMode}`,
    `warnings=${snapshot.warnings.length}`,
  ]
  for (const warning of snapshot.warnings.slice(0, 20)) {
    lines.push(`warning=${warning}`)
  }
  return lines
}

export function skipLedgerLines(
  skipReasons: Readonly<Record<string, Readonly<Record<string, number>>>>,
): string[] {
  const lines: string[] = []
  for (const [job, reasons] of Object.entries(skipReasons)) {
    for (const [reason, count] of Object.entries(reasons)) {
      lines.push(`job=${job} reason=${reason} count=${count}`)
      if (lines.length >= 80) {
        lines.push("truncated=true")
        return lines
      }
    }
  }
  return lines.length > 0 ? lines : ["skips=(none)"]
}

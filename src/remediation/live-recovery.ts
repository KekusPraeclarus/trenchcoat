import { existsSync, unlinkSync } from "node:fs"
import { basename, join } from "node:path"
import type { HealthSnapshot } from "../orchestrator/health.js"
import type { RemediationIncident, RemediationPhase } from "./schemas.js"

/** Phases that free the fingerprint unless a mapped job is degraded again */
export const TERMINAL_REMEDIATION_PHASES = new Set<RemediationPhase>([
  "completed",
  "failed",
  "ignored",
  "rejected",
  "rolled-back",
  "attention-required",
])

/** Leftover files from a prior build that must not enter a later pre-review */
export const POST_BUILD_ARTIFACT_NAMES = [
  "diff-summary.json",
  "gate.json",
  "post-review.json",
] as const

const UNMAPPED_LOG_STEMS = new Set([
  "orchestrator",
  "listener",
  "channels",
  "router",
])

export type LiveJobView = Readonly<{
  job: string
  lastSuccessAt?: string
  lastFailureAt?: string
}>

export type LiveFindingView = Readonly<{
  code: string
  job?: string
  component?: string
  summary: string
}>

export type LiveHealthView = Readonly<{
  jobs: readonly LiveJobView[]
  findings: readonly LiveFindingView[]
  xBlocked: boolean
  xSessionHeld: boolean
}>

export type LiveRecoveryDecision =
  | { kind: "proceed" }
  | { kind: "ignore"; reason: "already-recovered" }

export function liveHealthFromSnapshot(snapshot: HealthSnapshot): LiveHealthView {
  return {
    jobs: snapshot.jobs.map((job) => ({
      job: job.job,
      ...(job.lastSuccess ? { lastSuccessAt: job.lastSuccess.at } : {}),
      ...(job.lastFailure ? { lastFailureAt: job.lastFailure.at } : {}),
    })),
    findings: snapshot.findings.map((finding) => ({
      code: finding.code,
      ...(finding.job ? { job: finding.job } : {}),
      ...(finding.component ? { component: finding.component } : {}),
      summary: finding.summary,
    })),
    xBlocked: snapshot.x.blocked,
    xSessionHeld: snapshot.x.sessionHeld,
  }
}

/** Map a trenchcoat log path to health jobs. Empty means the host cannot prove recovery. */
export function jobsForLogPath(path: string): string[] {
  const base = basename(path)
  const match = /^trenchcoat\.(.+)\.(?:out|err)\.log$/u.exec(base)
  if (!match) return []
  const stem = match[1] ?? ""
  if (UNMAPPED_LOG_STEMS.has(stem)) return []
  if (stem === "x-scan") return ["list-scan"]
  return [stem]
}

export function jobsForIncident(incident: Readonly<{
  origin?: RemediationIncident["origin"]
  job?: string | undefined
  evidencePaths?: readonly string[] | undefined
}>): string[] {
  if (incident.job) return [incident.job]
  const fromLogs = (incident.evidencePaths ?? []).flatMap((path) => jobsForLogPath(path))
  return [...new Set(fromLogs)]
}

function parseIso(value: string | undefined): number | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

function jobByName(health: LiveHealthView, job: string): LiveJobView | undefined {
  return health.jobs.find((row) => row.job === job)
}

function jobHasFinding(health: LiveHealthView, job: string): boolean {
  return health.findings.some((finding) => finding.job === job)
}

function xScanUnitInactive(health: LiveHealthView): boolean {
  return health.findings.some((finding) =>
    finding.code === "systemd-unit-inactive"
    && /trenchcoat-x-scan/u.test(finding.summary),
  )
}

function listScanDegraded(health: LiveHealthView): boolean {
  return health.xBlocked || health.xSessionHeld || xScanUnitInactive(health)
}

export function jobIsHealthy(health: LiveHealthView, job: string): boolean {
  const row = jobByName(health, job)
  if (!row?.lastSuccessAt) return false
  const successMs = parseIso(row.lastSuccessAt)
  const failureMs = parseIso(row.lastFailureAt)
  if (successMs === undefined) return false
  if (failureMs !== undefined && failureMs >= successMs) return false
  if (jobHasFinding(health, job)) return false
  if (job === "list-scan" && listScanDegraded(health)) return false
  return true
}

export function jobIsDegraded(health: LiveHealthView, job: string): boolean {
  if (jobHasFinding(health, job)) return true
  if (job === "list-scan" && listScanDegraded(health)) return true
  const row = jobByName(health, job)
  if (!row) return false
  const successMs = parseIso(row.lastSuccessAt)
  const failureMs = parseIso(row.lastFailureAt)
  if (failureMs !== undefined && (successMs === undefined || failureMs >= successMs)) {
    return true
  }
  return false
}

function allMappedJobsHealthy(jobs: readonly string[], health: LiveHealthView): boolean {
  if (jobs.length === 0) return false
  return jobs.every((job) => jobIsHealthy(health, job))
}

function anyMappedJobDegraded(jobs: readonly string[], health: LiveHealthView): boolean {
  if (jobs.length === 0) return false
  return jobs.some((job) => jobIsDegraded(health, job))
}

/**
 * Host floor: do not diagnose or enqueue a log/health/skip incident when
 * every mapped job is healthy in the current snapshot.
 * Discord suggestions are product intake and skip this floor.
 */
export function decideLiveRecovery(args: Readonly<{
  origin?: RemediationIncident["origin"]
  jobs: readonly string[]
  health: LiveHealthView
}>): LiveRecoveryDecision {
  if (args.origin === "discord-suggestion") return { kind: "proceed" }
  if (args.origin !== "log" && args.origin !== "health" && args.origin !== "skip") {
    return { kind: "proceed" }
  }
  if (allMappedJobsHealthy(args.jobs, args.health)) {
    return { kind: "ignore", reason: "already-recovered" }
  }
  return { kind: "proceed" }
}

/**
 * Reopen a terminal fingerprint only when a mapped job is degraded now.
 * Unknown / unmapped jobs stay closed. Operator retry still sets triaged.
 */
export function shouldReopenTerminal(args: Readonly<{
  origin?: RemediationIncident["origin"]
  phase: RemediationPhase
  jobs: readonly string[]
  health: LiveHealthView
}>): boolean {
  if (!TERMINAL_REMEDIATION_PHASES.has(args.phase)) return false
  if (args.origin === "discord-suggestion") return false
  return anyMappedJobDegraded(args.jobs, args.health)
}

export function clearPostBuildArtifacts(artifactDir: string): void {
  for (const name of POST_BUILD_ARTIFACT_NAMES) {
    const path = join(artifactDir, name)
    if (existsSync(path)) unlinkSync(path)
  }
}

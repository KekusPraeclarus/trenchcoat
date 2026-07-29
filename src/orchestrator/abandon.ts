import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { archiveLayout } from "../lib/archive.js"
import { systemClock } from "../lib/clock.js"
import {
  DEPLOY_PAUSE_MAX_RUNNING_MS,
  isDeployPaused,
} from "../lib/deploy-pause.js"
import {
  agentLockPath,
  jobMutexPath,
  JOB_MUTEX_JOBS,
  signalWorkspaceLockHolder,
} from "../lib/lock.js"
import { log } from "../lib/log.js"
import { RUN_PHASES, markRunFailed, type RunJournal } from "./journal.js"
import { createJournalStore } from "./journal-store.js"
import {
  ABANDONED_CREATED_MS,
  findIncompleteRunRefs,
  type IncompleteRunRef,
} from "./resume.js"

/** Any still-running journal older than this is treated as an orphan */
export const ABANDONED_RUNNING_MS = ABANDONED_CREATED_MS

/**
 * Catch-up `outcomes-settle` can price a large wallet-buy backlog for many
 * hours (ADR 031). Do not hard-abandon while under this age — the job is
 * agent-lock exempt and intentionally long-running.
 */
export const OUTCOMES_SETTLE_ABANDON_MS = 24 * 3_600_000

/**
 * Pre-seal journals with no live writer lock after this age are SIGTERM orphans
 * (resume of pre-seal is unsupported — mark failed and re-run).
 */
export const ORPHAN_PRESEAL_NO_LOCK_MS = 30 * 60_000

/** Minimum interval between automatic orphan-abandon scans from runJob */
export const ORPHAN_ABANDON_THROTTLE_MS = 15 * 60_000

const ORPHAN_ABANDON_THROTTLE_FILE = "last-orphan-abandon.json"

const COMMITTED_IDX = RUN_PHASES.indexOf("committed")

export function isPreSealPhase(phase: IncompleteRunRef["phase"]): boolean {
  const idx = RUN_PHASES.indexOf(phase)
  return idx >= 0 && idx < COMMITTED_IDX
}

/** Job name prefix of a run id (`outcomes-settle-2026-…` → `outcomes-settle`) */
export function jobNameFromRunId(runId: string): string | undefined {
  const stamp = runId.match(/-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/u)
  if (!stamp || stamp.index === undefined || stamp.index === 0) return undefined
  return runId.slice(0, stamp.index)
}

export function hardAbandonAgeMs(runId: string): number {
  return jobNameFromRunId(runId) === "outcomes-settle"
    ? OUTCOMES_SETTLE_ABANDON_MS
    : ABANDONED_RUNNING_MS
}

function pidAliveFromOwnerFile(ownerPath: string): boolean {
  if (!existsSync(ownerPath)) return false
  const pid = Number(readFileSync(ownerPath, "utf8").trim())
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function workspaceLockHeldAlive(agentRoot: string): boolean {
  return pidAliveFromOwnerFile(`${agentLockPath(agentRoot)}.owner`)
}

/** True when a JOB_MUTEX_JOBS mutex owner pid is still alive */
export function jobMutexHeldAlive(home: string, job: string): boolean {
  if (!JOB_MUTEX_JOBS.has(job)) return false
  return pidAliveFromOwnerFile(`${jobMutexPath(home, job)}.owner`)
}

/**
 * Agent-lock-exempt jobs that hold a job mutex must not be treated as
 * pre-seal orphans just because `agent/.lock` is free (ADR 031).
 */
export function skipPreSealNoLockAbandon(args: Readonly<{
  runId: string
  home?: string
}>): boolean {
  const job = jobNameFromRunId(args.runId)
  if (!job || !JOB_MUTEX_JOBS.has(job)) return false
  if (args.home && jobMutexHeldAlive(args.home, job)) return true
  // Even without a live mutex (legacy pre-mutex process), do not apply the
  // 30m no-lock rule — only the longer hard age cap may abandon these jobs.
  return true
}

export function shouldAbandonIncomplete(args: Readonly<{
  ref: IncompleteRunRef
  lockHeld: boolean
  /** When true, also fail phase=created journals past ABANDONED_CREATED_MS */
  includeCreatedAbandoned?: boolean
  /** When true, fail long-running journals even if the workspace lock is live */
  deployPauseActive?: boolean
  /** Host home for job-mutex liveness (`~/.trenchcoat`) */
  home?: string
}>): boolean {
  const { ref, lockHeld } = args
  if (ref.status === "abandoned") return args.includeCreatedAbandoned === true
  if (ref.status !== "running") return false
  const ageMs = ref.ageMs
  if (ageMs === undefined) return false
  if (args.deployPauseActive === true && ageMs >= DEPLOY_PAUSE_MAX_RUNNING_MS) {
    return true
  }
  if (ageMs >= hardAbandonAgeMs(ref.runId)) return true
  if (
    isPreSealPhase(ref.phase)
    && !lockHeld
    && ageMs >= ORPHAN_PRESEAL_NO_LOCK_MS
    && !skipPreSealNoLockAbandon({ runId: ref.runId, ...(args.home ? { home: args.home } : {}) })
  ) {
    return true
  }
  return false
}

export async function failRunJournal(args: Readonly<{
  archiveRoot: string
  agentRoot?: string
  runId: string
  code: string
  message: string
  nowIso?: string
}>): Promise<RunJournal> {
  const store = createJournalStore(archiveLayout(args.archiveRoot))
  const existing = await store.load(args.runId)
  if (!existing) throw new Error(`journal missing: ${args.runId}`)
  if (existing.status === "complete") {
    throw new Error(`cannot fail completed run ${args.runId}`)
  }
  if (existing.status === "failed" && existing.failure) return existing
  const next = markRunFailed(existing, {
    code: args.code,
    message: args.message,
    failedAt: args.nowIso ?? systemClock.nowIso(),
  })
  await store.save(next)
  if (args.agentRoot) {
    await store.mirrorToAgent?.(args.agentRoot, next)
  }
  return next
}

export type AbandonResult = Readonly<{
  examined: number
  failed: readonly string[]
  skipped: readonly string[]
}>

/** Persist-fail orphaned incomplete journals so wait-idle / deploy can proceed */
export async function abandonOrphanedRuns(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  home?: string
  nowIso?: string
  /** When set, only fail these run ids (operator select) */
  onlyRunIds?: readonly string[]
  includeCreatedAbandoned?: boolean
  dryRun?: boolean
}>): Promise<AbandonResult> {
  const nowIso = args.nowIso ?? systemClock.nowIso()
  const home = args.home ?? join(homedir(), ".trenchcoat")
  const deployPauseActive = isDeployPaused(home, Date.parse(nowIso))
  const lockHeld = workspaceLockHeldAlive(args.agentRoot)
  const refs = await findIncompleteRunRefs(archiveLayout(args.archiveRoot), nowIso)
  const failed: string[] = []
  const skipped: string[] = []

  for (const ref of refs) {
    if (args.onlyRunIds && !args.onlyRunIds.includes(ref.runId)) continue
    if (!shouldAbandonIncomplete({
      ref,
      lockHeld,
      home,
      deployPauseActive,
      ...(args.includeCreatedAbandoned ? { includeCreatedAbandoned: true } : {}),
    })) {
      skipped.push(ref.runId)
      continue
    }
    if (args.dryRun) {
      failed.push(ref.runId)
      continue
    }
    try {
      const failureCode = ref.status === "abandoned"
        ? "orphan-created"
        : deployPauseActive && (ref.ageMs ?? 0) >= DEPLOY_PAUSE_MAX_RUNNING_MS
          ? "deploy-wait-timeout"
          : "orphan-stale"
      await failRunJournal({
        archiveRoot: args.archiveRoot,
        agentRoot: args.agentRoot,
        runId: ref.runId,
        code: failureCode,
        message: ref.status === "abandoned"
          ? `abandoned phase=created ageMs=${ref.ageMs ?? "unknown"}`
          : deployPauseActive && (ref.ageMs ?? 0) >= DEPLOY_PAUSE_MAX_RUNNING_MS
            ? `deploy pause blocked phase=${ref.phase} ageMs=${ref.ageMs ?? "unknown"} lockHeld=${lockHeld}`
            : `orphaned incomplete phase=${ref.phase} ageMs=${ref.ageMs ?? "unknown"} lockHeld=${lockHeld}`,
        nowIso,
      })
      if (failureCode === "deploy-wait-timeout" && lockHeld) {
        signalWorkspaceLockHolder(args.agentRoot)
      }
      failed.push(ref.runId)
      log.warn("abandoned orphaned run", {
        runId: ref.runId,
        phase: ref.phase,
        ageMs: ref.ageMs ?? null,
      })
    } catch (error) {
      log.error("failed to abandon run", {
        runId: ref.runId,
        detail: error instanceof Error ? error.message : "unknown",
      })
      skipped.push(ref.runId)
    }
  }

  return {
    examined: refs.length,
    failed,
    skipped,
  }
}

function orphanAbandonThrottlePath(home: string): string {
  return join(home, ORPHAN_ABANDON_THROTTLE_FILE)
}

function readOrphanAbandonThrottle(home: string): number | undefined {
  const path = orphanAbandonThrottlePath(home)
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { lastAttemptAt?: unknown }
    const t = Date.parse(typeof raw.lastAttemptAt === "string" ? raw.lastAttemptAt : "")
    return Number.isFinite(t) ? t : undefined
  } catch {
    return undefined
  }
}

function writeOrphanAbandonThrottle(home: string, nowIso: string): void {
  const path = orphanAbandonThrottlePath(home)
  writeFileSync(path, `${JSON.stringify({
    schema: 1,
    lastAttemptAt: nowIso,
  }, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Throttled orphan abandon for runJob — at most once per ORPHAN_ABANDON_THROTTLE_MS.
 * Errors are logged and never thrown to the caller.
 */
export async function maybeAbandonOrphansThrottled(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  home?: string
  nowIso?: string
}>): Promise<AbandonResult | undefined> {
  const nowIso = args.nowIso ?? systemClock.nowIso()
  const home = args.home ?? join(homedir(), ".trenchcoat")
  const nowMs = Date.parse(nowIso)
  const lastMs = readOrphanAbandonThrottle(home)
  if (lastMs !== undefined && nowMs - lastMs < ORPHAN_ABANDON_THROTTLE_MS) {
    return undefined
  }
  writeOrphanAbandonThrottle(home, nowIso)
  try {
    return await abandonOrphanedRuns({
      agentRoot: args.agentRoot,
      archiveRoot: args.archiveRoot,
      home,
      nowIso,
    })
  } catch (error) {
    log.error("orphan abandon throttle failed", {
      detail: error instanceof Error ? error.message : "unknown",
    })
    return undefined
  }
}

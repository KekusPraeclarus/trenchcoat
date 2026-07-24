import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { writeAtomicFile } from "./fs-atomic.js"

export const DEPLOY_PAUSE_SCHEMA = 1 as const

/** Orphaned pause files older than this are auto-cleared so a killed install cannot strand the host */
export const DEPLOY_PAUSE_MAX_AGE_MS = 45 * 60 * 1000

export type DeployPauseFile = Readonly<{
  schema: typeof DEPLOY_PAUSE_SCHEMA
  pausedAt: string
  reason: string
  deferredJobs: readonly string[]
}>

const SAFE_JOB = /^[a-z0-9-]{1,64}$/u

export function deployPausePath(home = join(homedir(), ".trenchcoat")): string {
  return join(home, "deploy-pause.json")
}

function clearPauseFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // already gone
  }
}

export function readDeployPause(
  home?: string,
  nowMs: number = Date.now(),
): DeployPauseFile | undefined {
  const path = deployPausePath(home)
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DeployPauseFile>
    if (raw.schema !== DEPLOY_PAUSE_SCHEMA) {
      clearPauseFile(path)
      return undefined
    }
    if (typeof raw.pausedAt !== "string" || typeof raw.reason !== "string") {
      clearPauseFile(path)
      return undefined
    }
    const pausedMs = Date.parse(raw.pausedAt)
    if (!Number.isFinite(pausedMs) || nowMs - pausedMs > DEPLOY_PAUSE_MAX_AGE_MS) {
      clearPauseFile(path)
      return undefined
    }
    const deferredJobs = Array.isArray(raw.deferredJobs)
      ? raw.deferredJobs.filter((j): j is string => typeof j === "string" && SAFE_JOB.test(j))
      : []
    return {
      schema: DEPLOY_PAUSE_SCHEMA,
      pausedAt: raw.pausedAt,
      reason: raw.reason.slice(0, 200),
      deferredJobs,
    }
  } catch {
    clearPauseFile(path)
    return undefined
  }
}

export function isDeployPaused(home?: string, nowMs: number = Date.now()): boolean {
  return readDeployPause(home, nowMs) !== undefined
}

export async function beginDeployPause(args: Readonly<{
  home?: string
  reason: string
  nowIso?: string
}>): Promise<DeployPauseFile> {
  const path = deployPausePath(args.home)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const next: DeployPauseFile = {
    schema: DEPLOY_PAUSE_SCHEMA,
    pausedAt: args.nowIso ?? new Date().toISOString(),
    reason: args.reason.slice(0, 200),
    deferredJobs: readDeployPause(args.home)?.deferredJobs ?? [],
  }
  await writeAtomicFile(path, `${JSON.stringify(next, null, 2)}\n`, 0o600)
  return next
}

/** Record a job that wanted to run while paused (for post-upgrade kickstart) */
export async function noteDeferredJob(args: Readonly<{
  home?: string
  job: string
}>): Promise<void> {
  if (!SAFE_JOB.test(args.job)) return
  const current = readDeployPause(args.home)
  if (!current) return
  if (current.deferredJobs.includes(args.job)) return
  const path = deployPausePath(args.home)
  const next: DeployPauseFile = {
    ...current,
    deferredJobs: [...current.deferredJobs, args.job],
  }
  await writeAtomicFile(path, `${JSON.stringify(next, null, 2)}\n`, 0o600)
}

export async function endDeployPause(home?: string): Promise<readonly string[]> {
  const path = deployPausePath(home)
  const deferred = readDeployPause(home)?.deferredJobs ?? []
  if (existsSync(path)) unlinkSync(path)
  return deferred
}

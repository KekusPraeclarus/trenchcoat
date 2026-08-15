import { openSync, closeSync, mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Jobs that never take the full-job agent workspace writer lock (INV-S15).
 * Improvement lanes use remediations/harness/repo-mutation confinement (ADR 027).
 * Wallet scan/settle/review release the critical section for provider I/O and
 * take a brief `withAgentWorkspaceLock` only for agent-state RMW (ADR 031).
 */
export const AGENT_LOCK_EXEMPT_JOBS = Object.freeze(new Set([
  "harness-improve",
  "harness-meta-improve",
  "incident-remediate",
  "incident-remediate-weekly",
  "outcomes-settle",
  "wallet-scan-solana",
  "wallet-scan-evm",
  "wallet-review",
]))

/**
 * Lock-exempt jobs that still need single-instance concurrency control via a
 * job-scoped mutex under `~/.trenchcoat/locks/` (not `agent/.lock`).
 * Catch-up `outcomes-settle` against a large wallet-buy backlog can run for
 * hours; without this mutex, timer + manual kicks stack and thrash bar APIs.
 */
export const JOB_MUTEX_JOBS = Object.freeze(new Set([
  "outcomes-settle",
]))

export function jobRequiresAgentWorkspaceLock(job: string): boolean {
  return !AGENT_LOCK_EXEMPT_JOBS.has(job)
}

export function jobRequiresJobMutex(job: string): boolean {
  return JOB_MUTEX_JOBS.has(job)
}

/** `~/.trenchcoat/locks/<job>.lock` (+ `.owner`) for JOB_MUTEX_JOBS */
export function jobMutexPath(home: string, job: string): string {
  return join(home, "locks", `${job}.lock`)
}

/** Exclusive workspace lock via O_EXCL owner file. Stale pid owners are cleared. */
export class WorkspaceLock {
  private owned = false

  constructor(private readonly lockPath: string) {}

  private ownerPath(): string {
    return `${this.lockPath}.owner`
  }

  tryAcquire(): boolean {
    mkdirSync(dirname(this.lockPath), { recursive: true, mode: 0o700 })
    if (existsSync(this.ownerPath())) {
      const existing = Number(readFileSync(this.ownerPath(), "utf8").trim())
      if (Number.isInteger(existing) && existing > 0) {
        try {
          process.kill(existing, 0)
          return false
        } catch {
          // stale owner
        }
      }
      try { unlinkSync(this.ownerPath()) } catch { /* race */ }
    }

    try {
      const fd = openSync(this.ownerPath(), "wx")
      writeFileSync(fd, `${process.pid}\n`)
      closeSync(fd)
      writeFileSync(this.lockPath, `${process.pid}\n`, { mode: 0o600 })
      this.owned = true
      return true
    } catch {
      return false
    }
  }

  release(): void {
    if (!this.owned) return
    this.owned = false
    try { unlinkSync(this.ownerPath()) } catch { /* ignore */ }
    try { unlinkSync(this.lockPath) } catch { /* ignore */ }
  }
}

export function agentLockPath(agentRoot: string): string {
  return join(agentRoot, ".lock")
}

/** Drop owner files when the recorded pid is gone */
export function clearStaleWorkspaceLock(agentRoot: string): boolean {
  const lockPath = agentLockPath(agentRoot)
  const ownerPath = `${lockPath}.owner`
  if (!existsSync(ownerPath)) return false
  const pid = Number(readFileSync(ownerPath, "utf8").trim())
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      // stale owner
    }
  }
  try { unlinkSync(ownerPath) } catch { /* race */ }
  try { unlinkSync(lockPath) } catch { /* race */ }
  return true
}

/** Best-effort nudge to a live lock holder (deploy pause abandon) */
export function signalWorkspaceLockHolder(
  agentRoot: string,
  signal: NodeJS.Signals = "SIGTERM",
): boolean {
  const ownerPath = `${agentLockPath(agentRoot)}.owner`
  if (!existsSync(ownerPath)) return false
  const pid = Number(readFileSync(ownerPath, "utf8").trim())
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Brief agent-lock hold for rare improvement-lane writes into agent state
 * (e.g. post-fix claim indexes). Retries so a long scan does not fail the
 * whole remediation job.
 */
export const AGENT_LOCK_HELD_MESSAGE = "workspace lock held — agent mutation deferred"

/** Default brief-RMW retry: 3 minutes, then callers may fail-soft. */
export const SETTLE_AGENT_LOCK_ATTEMPTS = 36
export const SETTLE_AGENT_LOCK_DELAY_MS = 5_000

export function isAgentLockHeldError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /workspace lock held/iu.test(message)
}

export async function withAgentWorkspaceLock<T>(
  agentRoot: string,
  fn: () => Promise<T>,
  opts?: Readonly<{ attempts?: number; delayMs?: number }>,
): Promise<T> {
  const attempts = Math.max(1, opts?.attempts ?? 12)
  const delayMs = Math.max(50, opts?.delayMs ?? 5_000)
  const lock = new WorkspaceLock(agentLockPath(agentRoot))
  for (let i = 0; i < attempts; i++) {
    if (lock.tryAcquire()) {
      try {
        return await fn()
      } finally {
        lock.release()
      }
    }
    if (i + 1 < attempts) await sleep(delayMs)
  }
  throw new Error(AGENT_LOCK_HELD_MESSAGE)
}

/**
 * Brief RMW that leaves work pending when a scan still holds agent/.lock.
 * Archive settlement must not fail the whole job after hours of pricing.
 */
export async function withAgentWorkspaceLockOrDefer<T>(
  agentRoot: string,
  fn: () => Promise<T>,
  opts?: Readonly<{ attempts?: number; delayMs?: number }>,
): Promise<{ ok: true, value: T } | { ok: false, deferred: true }> {
  try {
    const value = await withAgentWorkspaceLock(agentRoot, fn, opts)
    return { ok: true, value }
  } catch (error) {
    if (isAgentLockHeldError(error)) return { ok: false, deferred: true }
    throw error
  }
}

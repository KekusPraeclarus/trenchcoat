import { openSync, closeSync, mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Jobs that never take the main agent workspace writer lock (INV-S15).
 * They use their own stores/locks (remediations/, harness worktrees, repo
 * mutation lock) so continuous scans cannot starve improvement flows.
 */
export const AGENT_LOCK_EXEMPT_JOBS = Object.freeze(new Set([
  "harness-improve",
  "incident-remediate",
  "incident-remediate-weekly",
]))

export function jobRequiresAgentWorkspaceLock(job: string): boolean {
  return !AGENT_LOCK_EXEMPT_JOBS.has(job)
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Brief agent-lock hold for rare improvement-lane writes into agent state
 * (e.g. post-fix claim indexes). Retries so a long scan does not fail the
 * whole remediation job.
 */
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
  throw new Error("workspace lock held — agent mutation deferred")
}

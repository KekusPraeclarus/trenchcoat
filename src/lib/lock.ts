import { openSync, closeSync, mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

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

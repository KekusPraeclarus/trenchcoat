import { mkdtempSync, cpSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentLockPath, WorkspaceLock } from "../../src/lib/lock.js"
import { runJob } from "../../src/orchestrator/run.js"

describe("run loop locking", () => {
  it("refuses a concurrent workspace writer with exit code 3", async () => {
    const root = mkdtempSync(join(tmpdir(), "trenchcoat-agent-"))
    const agentRoot = join(root, "agent")
    cpSync(join(process.cwd(), "agent"), agentRoot, { recursive: true })
    mkdirSync(join(root, "archive"), { recursive: true })
    const lock = new WorkspaceLock(agentLockPath(agentRoot))
    expect(lock.tryAcquire()).toBe(true)

    try {
      await expect(runJob({
        job: "review",
        paths: { agentRoot, archiveRoot: join(root, "archive") },
        skipAgent: true,
        dryCollect: true,
      })).resolves.toMatchObject({ exitCode: 3 })
    } finally {
      lock.release()
    }
  })
})

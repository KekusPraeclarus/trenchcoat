import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  WorkspaceLock,
  jobMutexPath,
  jobRequiresJobMutex,
  JOB_MUTEX_JOBS,
} from "../../src/lib/lock.js"

describe("job mutex", () => {
  it("requires a mutex only for outcomes-settle among lock-exempt jobs", () => {
    expect(jobRequiresJobMutex("outcomes-settle")).toBe(true)
    expect(JOB_MUTEX_JOBS.has("outcomes-settle")).toBe(true)
    expect(jobRequiresJobMutex("wallet-scan-solana")).toBe(false)
    expect(jobRequiresJobMutex("list-scan")).toBe(false)
  })

  it("serialises two outcomes-settle acquisitions", () => {
    const home = mkdtempSync(join(tmpdir(), "tc-job-mutex-"))
    const path = jobMutexPath(home, "outcomes-settle")
    const first = new WorkspaceLock(path)
    const second = new WorkspaceLock(path)
    expect(first.tryAcquire()).toBe(true)
    expect(second.tryAcquire()).toBe(false)
    first.release()
    expect(second.tryAcquire()).toBe(true)
    second.release()
  })
})

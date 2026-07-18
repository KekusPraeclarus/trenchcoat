import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha256Json } from "../../src/lib/canonical-json.js"
import {
  advanceHarnessJournal,
  HARNESS_PHASES,
} from "../../src/harness/lifecycle.js"

describe("harness journal crash safety", () => {
  it("advances exactly once and rejects skips", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-hj-"))
    const archiveRoot = join(root, "archive")
    const id = "hyp-crash-1"
    const hash = sha256Json({ n: 1 } as never)
    const first = await advanceHarnessJournal(archiveRoot, id, "proposed", hash)
    expect(first.phase).toBe("proposed")
    const replay = await advanceHarnessJournal(archiveRoot, id, "proposed", hash)
    expect(replay).toEqual(first)
    await expect(
      advanceHarnessJournal(archiveRoot, id, "evaluated", sha256Json({ n: 2 } as never)),
    ).rejects.toThrow(/must advance/u)
    await advanceHarnessJournal(archiveRoot, id, "prepared", sha256Json({ n: 3 } as never))
    expect(HARNESS_PHASES.includes("canary")).toBe(true)
  })
})

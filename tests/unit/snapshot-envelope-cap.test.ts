import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { SNAPSHOT_MAX_ITEMS } from "../../src/contracts/schemas.js"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { writeXFypEligibleSnapshot } from "../../src/orchestrator/x-fyp-eligible.js"

describe("writeXFypEligibleSnapshot envelope cap", () => {
  it("caps overflow posts to SNAPSHOT_MAX_ITEMS with truncated marker", async () => {
    const agentRoot = mkdtempSync(join(tmpdir(), "tc-fyp-cap-"))
    const runId = "list-scan-fyp-cap"
    const writer = new SnapshotWriter(agentRoot)
    const total = SNAPSHOT_MAX_ITEMS + 8
    const posts = Array.from({ length: total }, (_, i) => ({
      id: String(10_000_000_000_000 + i),
      author: `user${i}`,
    }))
    const keep = SNAPSHOT_MAX_ITEMS - 1
    await writeXFypEligibleSnapshot({
      writer,
      runId,
      fetchedAt: "2026-07-19T20:00:00.000Z",
      posts: posts.slice(0, keep),
      truncatedBy: total - keep,
    })
    const envelope = JSON.parse(
      readFileSync(join(agentRoot, "inbox", runId, "x-fyp-eligible.json"), "utf8"),
    ) as { items: ReadonlyArray<{ text: string }> }
    expect(envelope.items).toHaveLength(SNAPSHOT_MAX_ITEMS)
    expect(envelope.items.at(-1)?.text).toBe(`truncated=${total - keep}`)
  })
})

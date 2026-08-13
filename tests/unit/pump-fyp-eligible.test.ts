import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { SNAPSHOT_MAX_ITEMS } from "../../src/contracts/schemas.js"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { writePumpFypEligibleSnapshot } from "../../src/orchestrator/pump-fyp-eligible.js"

describe("writePumpFypEligibleSnapshot envelope cap", () => {
  it("caps overflow items to SNAPSHOT_MAX_ITEMS with truncated marker", async () => {
    const agentRoot = mkdtempSync(join(tmpdir(), "tc-pump-fyp-cap-"))
    const runId = "pump-scan-fyp-cap"
    const writer = new SnapshotWriter(agentRoot)
    const total = SNAPSHOT_MAX_ITEMS + 8
    const items = Array.from({ length: total }, (_, i) => ({
      itemId: `coin-${i}`,
      author: `user${i}`,
    }))
    await writePumpFypEligibleSnapshot({
      writer,
      runId,
      fetchedAt: "2026-08-13T12:00:00.000Z",
      items,
    })
    const envelope = JSON.parse(
      readFileSync(join(agentRoot, "inbox", runId, "pump-fyp-eligible.json"), "utf8"),
    ) as { items: ReadonlyArray<{ text: string }> }
    expect(envelope.items).toHaveLength(SNAPSHOT_MAX_ITEMS)
    expect(envelope.items.at(-1)?.text.startsWith("truncated=")).toBe(true)
  })
})

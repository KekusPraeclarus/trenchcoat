import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { collectForJob } from "../../src/orchestrator/collect.js"

describe("list-scan collect skipAgent", () => {
  it("sets skipAgent when no posts and no agent-alpha paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-ls-skip-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "alpha-queue"), { recursive: true })
    mkdirSync(join(agentRoot, "state", "research"), { recursive: true })
    const writer = new SnapshotWriter(agentRoot)
    const runId = "list-scan-2026-07-23T12-00-00-000Z"
    const summary = await collectForJob({
      job: "list-scan",
      runId,
      writer,
      fetchedAt: "2026-07-23T12:00:00.000Z",
      agentRoot,
      archiveRoot: join(root, "archive"),
      listScanOverride: {
        bundles: [],
        includeAlphaManifest: true,
      },
    })
    expect(summary.postCount).toBe(0)
    expect(summary.skipAgent).toBe(true)
    expect(summary.collectionStatus).toBe("no-signal")
    expect(summary.agentAlphaPathCount ?? 0).toBe(0)
  })
})

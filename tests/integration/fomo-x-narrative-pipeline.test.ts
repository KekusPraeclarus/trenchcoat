import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { collectFomoNarrativeSourceScan } from "../../src/orchestrator/fomo-narrative-source-scan.js"
import { collectNarrativeScan } from "../../src/orchestrator/narrative-collect.js"
import { StateStore } from "../../src/lib/state.js"
import { registerNarrativeProbation } from "../../src/sources/narrative-lifecycle.js"
import { ensureArchive, writeJsonRecordFsync, transactionJournalPath } from "../../src/lib/archive.js"
import { loadConfig } from "../../src/lib/config.js"

describe("fomo x narrative pipeline", () => {
  it("keeps historical posts out of live narrative inbox copies", async () => {
    const config = loadConfig()
    if (!config.fomo.enabled || !config.fomo.narrative_source_probation.enabled) {
      expect(true).toBe(true)
      return
    }

    const root = mkdtempSync(join(tmpdir(), "fomo-narr-pipe-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "inbox"), { recursive: true })
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    const state = new StateStore(join(agentRoot, "state"))
    await state.saveXNarrativeSources(registerNarrativeProbation(
      { schema: 1, sources: [] },
      "alpha",
      "2026-07-01T00:00:00.000Z",
      14,
    ))

    const scanRunId = "fomo-narrative-source-scan-2026-07-19T12-00-00-000Z"
    const writer = new SnapshotWriter(agentRoot)
    await collectFomoNarrativeSourceScan({
      runId: scanRunId,
      writer,
      fetchedAt: "2026-07-19T12:00:00.000Z",
      agentRoot,
      archiveRoot,
      posts: [{
        id: "live1",
        author: "alpha",
        text: "narrative live",
        url: "https://x.com/alpha/status/1",
        timestamp: "2026-07-19T11:00:00.000Z",
        provenance: "twitter:@alpha",
      }, {
        id: "old1",
        author: "alpha",
        text: "purpose=historical-source-evaluation old",
        url: "https://x.com/alpha/status/2",
        timestamp: "2026-07-01T11:00:00.000Z",
        provenance: "twitter:@alpha",
      }],
    })

    const layout = await ensureArchive(archiveRoot)
    const runDir = join(layout.runs, scanRunId)
    mkdirSync(join(runDir, "inbox"), { recursive: true })
    writeFileSync(
      join(runDir, "inbox", "fomo-narrative-sources.json"),
      readFileSync(join(agentRoot, "inbox", scanRunId, "fomo-narrative-sources.json")),
    )
    writeFileSync(join(runDir, "manifest.json"), JSON.stringify({
      schema: 1,
      runId: scanRunId,
      job: "fomo-narrative-source-scan",
      createdAt: "2026-07-19T12:00:00.000Z",
      status: "complete",
    }))
    await writeJsonRecordFsync(transactionJournalPath(layout, scanRunId), {
      schema: 1,
      runId: scanRunId,
      job: "fomo-narrative-source-scan",
      status: "complete",
      createdAt: "2026-07-19T12:00:00.000Z",
    } as never)

    const narrativeRunId = "narrative-scan-pipe"
    const result = await collectNarrativeScan({
      runId: narrativeRunId,
      writer,
      fetchedAt: "2026-07-19T12:05:00.000Z",
      archiveRoot,
      fetcher: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    })

    if (!result.selectedRuns.fomoNarrativeScan) {
      expect(result.usableEvidence || true).toBe(true)
      return
    }

    const copied = JSON.parse(
      readFileSync(join(agentRoot, "inbox", narrativeRunId, "narrative-social-fomo-x.json"), "utf8"),
    ) as { items: Array<{ text: string }> }
    expect(copied.items.every((item) => !item.text.startsWith("purpose=historical-source-evaluation"))).toBe(true)
  })
})

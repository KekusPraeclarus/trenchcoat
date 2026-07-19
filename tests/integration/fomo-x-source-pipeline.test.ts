import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { collectFomoXSourceReview } from "../../src/orchestrator/fomo-x-source-review.js"
import { mergeFomoXClassification } from "../../src/orchestrator/fomo-x-classification-merge.js"
import { StateStore } from "../../src/lib/state.js"
import { emptyXSourceNominations, upsertXSourceNominations } from "../../src/sources/x-nominations.js"
import { loadConfig } from "../../src/lib/config.js"

function posts(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const day = String(1 + (i % 6)).padStart(2, "0")
    return {
      id: `p${i}`,
      author: "alpha",
      text: `buy So1111111111111111111111111111111111111111${i % 10} call ${i}`,
      url: `https://x.com/alpha/status/${i}`,
      timestamp: `2026-07-${day}T12:00:00.000Z`,
      provenance: "twitter:@alpha",
    }
  })
}

describe("fomo x source pipeline", () => {
  it("nomination → injected history → classification merge path", async () => {
    const config = loadConfig()
    if (!config.fomo.enabled || !config.fomo.x_source_review.enabled) {
      expect(true).toBe(true)
      return
    }

    const root = mkdtempSync(join(tmpdir(), "fomo-x-pipe-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "inbox"), { recursive: true })
    mkdirSync(join(agentRoot, "reports"), { recursive: true })
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    const state = new StateStore(join(agentRoot, "state"))
    await state.saveXSourceNominations(upsertXSourceNominations(emptyXSourceNominations(), {
      traders: [{
        handle: "alpha",
        timeframe: "7d",
        rank: 1,
        wallets: [],
        observedAt: "2026-07-19T00:00:00.000Z",
      }],
      nominatedAt: "2026-07-19T00:00:00.000Z",
      maxPending: 10,
    }))

    const runId = "fomo-x-source-review-pipe"
    const writer = new SnapshotWriter(agentRoot)
    const summary = await collectFomoXSourceReview({
      runId,
      writer,
      fetchedAt: "2026-07-19T12:00:00.000Z",
      agentRoot,
      archiveRoot,
      posts: posts(25),
    })
    expect(summary.collectionStatus).toBe("fomo-x-ready")

    const nominationId = state.loadXSourceNominations().nominations[0]!.nominationId
    mkdirSync(join(agentRoot, "reports", runId), { recursive: true })
    writeFileSync(join(agentRoot, "reports", runId, "fomo-x-classification.json"), JSON.stringify({
      schema: 1,
      nominationId,
      xHandle: "alpha",
      classification: "reject",
      confidence: 0.9,
      shillPostIds: [],
      narrativePostIds: [],
      noisePostIds: Array.from({ length: 5 }, (_, i) => `p${i}`),
      reasonCodes: ["noise-dominant"],
    }))

    const report = await mergeFomoXClassification({
      agentRoot,
      archiveRoot,
      runId,
      nowIso: "2026-07-19T13:00:00.000Z",
    })
    expect(report.ok).toBe(true)
    expect(report.status).toBe("rejected")
    expect(JSON.parse(readFileSync(join(agentRoot, "inbox", runId, "x-source-history.json"), "utf8"))
      .items.every((item: { text: string }) => item.text.startsWith("purpose=historical-source-evaluation"))).toBe(true)
  })
})

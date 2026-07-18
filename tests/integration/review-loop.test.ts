import { describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive, runArchiveDir } from "../../src/lib/archive.js"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { StateStore } from "../../src/lib/state.js"
import { createJournalStore } from "../../src/orchestrator/journal-store.js"
import { collectReview, hashResearchDir } from "../../src/orchestrator/review-collect.js"
import { reconcileIndex } from "../../src/orchestrator/index-reconcile.js"

const NOW = "2026-07-18T12:00:00.000Z"

async function seedSealedRun(args: Readonly<{
  layout: Awaited<ReturnType<typeof ensureArchive>>
  agentRoot: string
  runId: string
  createdAt: string
}>): Promise<void> {
  const store = createJournalStore(args.layout)
  await store.save({
    schema: 1,
    runId: args.runId,
    phase: "complete",
    status: "complete",
    phaseHashes: {},
    sideEffects: {},
  })

  const runDir = runArchiveDir(args.layout, args.runId)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, "manifest.json"), `${JSON.stringify({
    schema: 1,
    runId: args.runId,
    job: "list-scan",
    createdAt: args.createdAt,
    inboxManifest: {},
    fileHashes: {},
  }, null, 2)}\n`)

  const reportDir = join(args.agentRoot, "reports", args.runId)
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(join(reportDir, "agent.md"), "# list-scan\n\nfixture\n")
}

describe("review distillation integration", () => {
  it("collector launches scope and research distillation reconciles INDEX", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tc-review-loop-")))
    const agentRoot = join(root, "agent")
    mkdirSync(agentRoot, { recursive: true })
    const archiveRoot = join(root, "archive")
    const layout = await ensureArchive(archiveRoot)
    await seedSealedRun({
      layout,
      agentRoot,
      runId: "list-scan-2026-07-17T00-00-00-000Z",
      createdAt: "2026-07-17T00:00:00.000Z",
    })

    const state = new StateStore(join(agentRoot, "state"))
    await state.saveWatchlist({
      schema: 1,
      entries: [{
        schema: 1,
        identity: {
          chain: "solana",
          tokenAddress: "So11111111111111111111111111111111111111112",
          pairAddress: "So11111111111111111111111111111111111111112",
          symbolDisplay: "SOL",
          resolution: "resolved",
        },
        status: "tracking",
        addedAt: NOW,
        updatedAt: NOW,
      }],
    })

    const macroTs = String(Math.floor(Date.parse(NOW) / 1000))
    const collection = await collectReview({
      runId: "review-2026-07-18T12-00-00-000Z",
      writer: new SnapshotWriter(agentRoot),
      fetchedAt: NOW,
      agentRoot,
      archiveRoot,
      fetcher: async () => new Response(JSON.stringify({
        data: [{ value: "50", value_classification: "Neutral", timestamp: macroTs }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    })

    expect(collection.skipAgent).toBe(false)
    expect(collection.sealedReportCount).toBe(1)
    expect(existsSync(join(
      agentRoot,
      "inbox",
      "review-2026-07-18T12-00-00-000Z",
      "review-reports-manifest.json",
    ))).toBe(true)

    const researchDir = join(agentRoot, "state", "research")
    mkdirSync(researchDir, { recursive: true })
    const before = hashResearchDir(agentRoot)
    writeFileSync(join(researchDir, "SOL.md"), [
      "---",
      "description: SOL distillation",
      "status: active",
      "last_verified: 2026-07-18",
      "---",
      "",
      "Compressed notes from review.",
      "",
    ].join("\n"))
    const after = hashResearchDir(agentRoot)
    expect(after).not.toBe(before)

    const reconcileReport = await reconcileIndex({ agentRoot, state, nowIso: NOW })
    expect(reconcileReport.tokenLines).toBeGreaterThan(0)
    const index = readFileSync(join(agentRoot, "state", "INDEX.md"), "utf8")
    expect(index).toMatch(/\$SOL/)
    expect(index).toContain("state/research/SOL.md")
  })
})

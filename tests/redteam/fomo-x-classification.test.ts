import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mergeFomoXClassification } from "../../src/orchestrator/fomo-x-classification-merge.js"
import { StateStore } from "../../src/lib/state.js"
import { emptyXSourceNominations, upsertXSourceNominations } from "../../src/sources/x-nominations.js"

describe("redteam fomo-x classification confinement", () => {
  it("rejects handle mutation and does not write managed-list lifecycle from classification alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "fomo-x-red-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "inbox", "run-rt"), { recursive: true })
    mkdirSync(join(agentRoot, "reports", "run-rt"), { recursive: true })
    mkdirSync(join(agentRoot, "state"), { recursive: true })

    const state = new StateStore(join(agentRoot, "state"))
    let nominations = upsertXSourceNominations(emptyXSourceNominations(), {
      traders: [{
        handle: "alpha",
        timeframe: "7d",
        rank: 1,
        wallets: [],
        observedAt: "2026-07-19T00:00:00.000Z",
      }],
      nominatedAt: "2026-07-19T00:00:00.000Z",
      maxPending: 10,
    })
    const id = nominations.nominations[0]!.nominationId
    nominations = {
      schema: 1,
      nominations: nominations.nominations.map((n) => (
        n.nominationId === id ? { ...n, status: "classifying" as const, attempts: 1 } : n
      )),
    }
    await state.saveXSourceNominations(nominations)
    writeFileSync(join(agentRoot, "state", "source-lifecycle.json"), JSON.stringify({
      schema: 1,
      candidates: [],
      transitions: [],
      pendingTransitionIds: [],
    }))
    const lifecycleBefore = readFileSync(join(agentRoot, "state", "source-lifecycle.json"), "utf8")

    writeFileSync(join(agentRoot, "inbox", "run-rt", "x-source-manifest.json"), JSON.stringify({
      schema: 1,
      source: "host.fomo-x-source-review",
      fetchedAt: "2026-07-19T00:00:00.000Z",
      trust: "untrusted-external",
      items: [{
        provenance: "run-rt:manifest",
        text: `nominationId=${id} xHandle=alpha fomoHandle=alpha matchBasis=same-handle sealedPostIds=${Array.from({ length: 25 }, (_, i) => `p${i}`).join(",")} postCount=25 activeDays=5`,
        ts: "2026-07-19T00:00:00.000Z",
        ageSec: 0,
        freshnessTier: "live",
      }],
    }))

    writeFileSync(join(agentRoot, "reports", "run-rt", "fomo-x-classification.json"), JSON.stringify({
      schema: 1,
      nominationId: id,
      xHandle: "evil_other",
      classification: "both",
      confidence: 0.99,
      shillPostIds: Array.from({ length: 5 }, (_, i) => `p${i}`),
      narrativePostIds: Array.from({ length: 5 }, (_, i) => `p${i + 5}`),
      noisePostIds: [],
      reasonCodes: ["mixed-role"],
    }))

    const report = await mergeFomoXClassification({
      agentRoot,
      archiveRoot,
      runId: "run-rt",
      nowIso: "2026-07-19T01:00:00.000Z",
    })
    expect(report.ok).toBe(false)
    expect(report.reason).toBe("handle-mismatch")
    expect(readFileSync(join(agentRoot, "state", "source-lifecycle.json"), "utf8")).toBe(lifecycleBefore)
    expect(existsSync(join(agentRoot, "state", "x-engagement.json"))).toBe(false)
  })
})

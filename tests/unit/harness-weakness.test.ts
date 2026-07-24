import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive } from "../../src/lib/archive.js"
import { DEFAULT_IMPROVER_CONFIG } from "../../src/harness/improver-config.js"
import {
  filterAllowlistedSignals,
  mineWeaknessFromSealedEpoch,
} from "../../src/harness/weakness-mining.js"
import { buildKeepSummary } from "../../src/harness/keep-summary.js"
import {
  sealScorecardEpoch,
  seedDecisionWithOutcome,
} from "../helpers/harness-archive.js"
import { loadSealedEpoch } from "../../src/orchestrator/scorecard.js"

describe("weakness-mining", () => {
  it("filters card prose and only allowlisted signal keys", () => {
    const filtered = filterAllowlistedSignals(
      { confidence: 40, evil: 1, "role:x": 0.5, thesis: 9 },
      ["confidence", "role:"],
    )
    expect(filtered).toEqual({ confidence: 40, "role:x": 0.5 })
    expect(filtered).not.toHaveProperty("evil")
    expect(filtered).not.toHaveProperty("thesis")
  })

  it("mines track-miss patterns deterministically from sealed outcomes", async () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "mine-"))
    const layout = await ensureArchive(archiveRoot)
    const subjects = Array.from({ length: 8 }, (_, i) => ({ id: `d-${i}` }))
    await sealScorecardEpoch({
      archiveRoot,
      epochId: "dev",
      hits: 2,
      subjects,
    })
    for (let i = 0; i < 8; i += 1) {
      await seedDecisionWithOutcome({
        layout,
        decisionId: `d-${i}`,
        verdict: "track",
        confidence: 55,
        excessReturn: i < 2 ? 0.3 : -0.1,
        signals: { confidence: 55, clusters: 1 },
      })
    }
    const sealed = loadSealedEpoch(layout, "dev")
    const cfg = {
      ...DEFAULT_IMPROVER_CONFIG,
      mining: { ...DEFAULT_IMPROVER_CONFIG.mining, minClusterSize: 3 },
    }
    const a = mineWeaknessFromSealedEpoch(
      layout,
      sealed,
      cfg,
      0.20,
    )
    const b = mineWeaknessFromSealedEpoch(
      layout,
      sealed,
      cfg,
      0.20,
    )
    expect(a.patterns.length).toBeGreaterThan(0)
    expect(a.patterns[0]!.patternId).toBe(b.patterns[0]!.patternId)
    expect(JSON.stringify(a.patterns)).toBe(JSON.stringify(b.patterns))
    const blob = JSON.stringify(a)
    expect(blob).not.toMatch(/IGNORE/)
    expect(blob).not.toMatch(/thesis/)
  })

  it("builds keep summary only from track hits", async () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "keep-"))
    const layout = await ensureArchive(archiveRoot)
    const subjects = Array.from({ length: 6 }, (_, i) => ({ id: `k-${i}` }))
    await sealScorecardEpoch({ archiveRoot, epochId: "dev", hits: 5, subjects })
    for (let i = 0; i < 6; i += 1) {
      await seedDecisionWithOutcome({
        layout,
        decisionId: `k-${i}`,
        verdict: "track",
        confidence: 70,
        excessReturn: i < 5 ? 0.25 : -0.05,
      })
    }
    const sealed = loadSealedEpoch(layout, "dev")
    const keep = buildKeepSummary(
      layout,
      sealed,
      {
        ...DEFAULT_IMPROVER_CONFIG,
        mining: { ...DEFAULT_IMPROVER_CONFIG.mining, minClusterSize: 3 },
      },
      0.20,
    )
    expect(keep.evidence.length + keep.patterns.length).toBeGreaterThan(0)
    expect(JSON.stringify(keep)).not.toMatch(/IGNORE/)
  })
})

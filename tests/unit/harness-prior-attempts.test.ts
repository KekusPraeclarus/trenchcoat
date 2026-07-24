import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive } from "../../src/lib/archive.js"
import { saveHypothesis } from "../../src/harness/propose.js"
import { writeRejectionReceipt } from "../../src/harness/lifecycle.js"
import {
  buildPriorAttemptsSummary,
  isExactDuplicate,
  isNearDuplicateSamePatternLever,
  rebuildPriorAttemptsIndex,
} from "../../src/harness/prior-attempts.js"
import { HarnessHypothesisSchema } from "../../src/contracts/schemas.js"

describe("prior-attempts", () => {
  it("indexes rejections idempotently and detects duplicates", async () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "prior-"))
    await ensureArchive(archiveRoot)
    const hyp = HarnessHypothesisSchema.parse({
      schema: 1,
      hypothesisId: "hyp-rej-1",
      createdAt: "2026-07-16T00:00:00.000Z",
      epochId: "dev",
      manifestHash: `sha256:${"d".repeat(64)}`,
      primaryMetric: "hitRate",
      safetyFloors: {},
      allowlistPaths: ["agent/skills/decision-policy/policy.json"],
      sampleRequirements: { minEvents: 1, minHoldoutEvents: 1 },
      rollbackConditions: ["rug"],
      rationale: "test",
      status: "rejected",
      weaknessPatternId: "pat-1",
    })
    await saveHypothesis(archiveRoot, hyp)
    await writeRejectionReceipt(archiveRoot, {
      schema: 1,
      hypothesisId: hyp.hypothesisId,
      rejectedAt: "2026-07-16T01:00:00.000Z",
      phase: "holdout_evaluated",
      reason: "primary-not-improved on holdout",
    })

    const first = await rebuildPriorAttemptsIndex(archiveRoot)
    const second = await rebuildPriorAttemptsIndex(archiveRoot)
    expect(first.length).toBe(1)
    expect(second.length).toBe(1)
    expect(first[0]!.primaryMetric).toBe("hitRate")

    const summary = buildPriorAttemptsSummary(archiveRoot, {
      nowIso: "2026-07-16T02:00:00.000Z",
      maxRecords: 10,
    })
    expect(summary.records.length).toBe(1)
    expect(JSON.stringify(summary)).not.toMatch(/ignore all gates/i)

    expect(first[0]!.primaryMetric).toBe("hitRate")
    expect(isNearDuplicateSamePatternLever({
      primaryMetric: "hitRate",
      weaknessPatternId: "pat-1",
    }, first)).toBeTruthy()
    if (first[0]!.planFingerprint) {
      expect(isExactDuplicate({
        planFingerprint: first[0]!.planFingerprint as `sha256:${string}`,
      }, first)).toBeTruthy()
    }
  })
})

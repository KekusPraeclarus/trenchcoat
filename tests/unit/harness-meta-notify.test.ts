import { describe, expect, it } from "vitest"
import { mkdtempSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MetaCandidateSchema,
  MetaUtilitySummarySchema,
} from "../../src/contracts/schemas.js"
import {
  loadMetaOperatorNotifyReceipt,
  notifyMetaPromotionEligible,
  renderMetaPromotionEligibleNotify,
} from "../../src/harness/meta-operator-notify.js"
import { hasLocalWorkspaceRefs } from "../../src/lib/telegram-format.js"

const HASH = `sha256:${"b".repeat(64)}` as const

function eligibleCandidate(id = "mc-notify-1") {
  return MetaCandidateSchema.parse({
    schema: 1,
    candidateId: id,
    createdAt: "2026-07-24T12:00:00.000Z",
    baseConfigHash: HASH,
    candidateConfigHash: `sha256:${"c".repeat(64)}`,
    status: "promotion_eligible",
    rationale: "Raised minClusterSize 5→6 after thin prior attempts",
  })
}

function eligibleUtility(id = "mc-notify-1") {
  return MetaUtilitySummarySchema.parse({
    schema: 1,
    candidateId: id,
    computedAt: "2026-07-24T12:00:00.000Z",
    validPairs: 8,
    candidateWins: 5,
    baselineWins: 2,
    ties: 1,
    candidateWinRate: 5 / 7,
    baselineWinRate: 2 / 7,
    candidateProtectedRegressions: 0,
    baselineProtectedRegressions: 1,
    candidateInvalidCount: 0,
    baselineInvalidCount: 0,
    medianCandidatePrimaryDelta: 0.12,
    medianBaselinePrimaryDelta: 0.04,
    safetyIntegrityOk: true,
    promotionEligible: true,
  })
}

describe("meta promotion_eligible operator notify", () => {
  it("renders a self-contained briefing without workspace paths", () => {
    const text = renderMetaPromotionEligibleNotify({
      candidate: eligibleCandidate(),
      utility: eligibleUtility(),
    })
    expect(text).toContain("promotion eligible")
    expect(text).toContain("mc-notify-1")
    expect(text).toContain("trenchcoat harness meta status")
    expect(text).toContain("trenchcoat harness meta promote mc-notify-1")
    expect(text).toContain("trenchcoat harness meta reject mc-notify-1")
    expect(text).toContain("**not** live yet")
    expect(text).toContain("config/harness-improver.json")
    expect(hasLocalWorkspaceRefs(text)).toBe(false)
  })

  it("sends once and writes an idempotent receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-meta-notify-"))
    const archiveRoot = join(root, "archive")
    const sent: string[] = []
    const candidate = eligibleCandidate()
    const utility = eligibleUtility()

    const first = await notifyMetaPromotionEligible({
      archiveRoot,
      candidate,
      utility,
      nowIso: "2026-07-24T12:00:00.000Z",
      send: async (text) => {
        sent.push(text)
      },
    })
    expect(first.sent).toBe(true)
    expect(sent).toHaveLength(1)
    expect(loadMetaOperatorNotifyReceipt(archiveRoot, candidate.candidateId)?.kind)
      .toBe("promotion_eligible")

    const second = await notifyMetaPromotionEligible({
      archiveRoot,
      candidate,
      utility,
      nowIso: "2026-07-24T13:00:00.000Z",
      send: async (text) => {
        sent.push(text)
      },
    })
    expect(second.sent).toBe(false)
    expect(second.skippedReason).toBe("already-notified")
    expect(sent).toHaveLength(1)
  })

  it("does not write a receipt when send fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-meta-notify-fail-"))
    const archiveRoot = join(root, "archive")
    const candidate = eligibleCandidate("mc-fail-1")
    const utility = eligibleUtility("mc-fail-1")

    const result = await notifyMetaPromotionEligible({
      archiveRoot,
      candidate,
      utility,
      nowIso: "2026-07-24T12:00:00.000Z",
      send: async () => {
        throw new Error("telegram down")
      },
    })
    expect(result.sent).toBe(false)
    expect(result.skippedReason).toBe("send-failed")
    expect(loadMetaOperatorNotifyReceipt(archiveRoot, candidate.candidateId))
      .toBeUndefined()
    expect(existsSync(
      join(root, "harness-improvements", "meta", "mc-fail-1", "operator-notify.json"),
    )).toBe(false)
  })
})

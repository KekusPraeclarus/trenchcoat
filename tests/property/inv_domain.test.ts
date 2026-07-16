import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { parseIntentVerdict } from "../../src/orchestrator/intent.js"
import { blendWalletScores, deterministicWalletScore } from "../../src/wallets/scoring.js"
import { parseIntentVerdict as parseCallIntent } from "../../src/lib/source-scoring.js"
import { canSendBroadcast, dayKey } from "../../src/orchestrator/broadcast.js"

describe("domain invariants", () => {
  it("prop_inv_s12_intent_parser_is_fail_closed", () => {
    fc.assert(fc.property(fc.string(), (output) => {
      const expected = output.trim().toLowerCase().split(/\s+/u)[0] === "warn" ? "warn" : "shill"
      expect(parseCallIntent(output)).toBe(expected)
      expect(parseIntentVerdict(output)).toBe(expected)
    }))
  })

  it("prop_inv_s19_llm_weight_is_bounded", () => {
    fc.assert(fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (score) => {
      const det = deterministicWalletScore({
        posteriorHitQuality: score,
        medianExcessQuality: score,
        leadTimeQuality: score,
        drawdownAndRugQuality: score,
        coverageDiversityActivity: score,
      })
      const blended = blendWalletScores(det, 100)
      expect(blended).toBeCloseTo(0.8 * det + 0.2, 5)
      expect(blended).toBeLessThanOrEqual(1)
      expect(blended).toBeGreaterThanOrEqual(0)
    }))
  })

  it("prop_inv_b4_urgent_ceiling_halts", () => {
    const item = {
      severity: "urgent" as const,
      text: "x",
      refs: ["state/decisions.md"],
      auditClaim: {
        type: "token-downside" as const,
        subject: "token",
        direction: "down" as const,
        horizonHours: 24,
        verificationRule: "token.down.72h",
      },
    }
    expect(canSendBroadcast(item, {
      dayKey: dayKey(),
      used: 5,
      urgentUsed: 10,
    }, { daily_budget: 5, urgent_ceiling: 10 }).ok).toBe(false)
  })
})

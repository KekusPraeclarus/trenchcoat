import { describe, expect, it } from "vitest"
import {
  PUMP_BOT_HEALTH_ESCALATION_THRESHOLD,
  emptyPumpBotHealth,
  pumpBotHealthEscalation,
  transitionPumpBotHealth,
} from "../../src/orchestrator/pump-bot-health.js"
import type { PumpEngagementReceipt } from "../../src/contracts/schemas.js"

function receipt(
  args: Partial<PumpEngagementReceipt> & Pick<PumpEngagementReceipt, "verified" | "ambiguous">,
): PumpEngagementReceipt {
  return {
    schema: 1,
    receiptId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    actionId: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    action: "like",
    target: "coin-1",
    attemptedAt: "2026-08-13T12:00:00.000Z",
    ...args,
  }
}

describe("pump-bot-health transitions", () => {
  it("escalates only once consecutive failures reach the threshold", () => {
    let health = emptyPumpBotHealth("2026-08-13T11:00:00.000Z")
    for (let i = 0; i < PUMP_BOT_HEALTH_ESCALATION_THRESHOLD; i += 1) {
      expect(pumpBotHealthEscalation(health).escalate).toBe(false)
      health = transitionPumpBotHealth({
        current: health,
        nowIso: `2026-08-13T1${i}:00:00.000Z`,
        runId: "pump-scan-1",
        receipts: [receipt({
          verified: false,
          ambiguous: true,
          error: "like control missing",
        })],
      })
    }
    const escalation = pumpBotHealthEscalation(health)
    expect(health.consecutiveFailures).toBe(PUMP_BOT_HEALTH_ESCALATION_THRESHOLD)
    expect(escalation.escalate).toBe(true)
  })

  it("clears escalation after a verified action", () => {
    const failing = {
      ...emptyPumpBotHealth("2026-08-13T11:00:00.000Z"),
      consecutiveFailures: PUMP_BOT_HEALTH_ESCALATION_THRESHOLD,
    }
    expect(pumpBotHealthEscalation(failing).escalate).toBe(true)
    const recovered = transitionPumpBotHealth({
      current: failing,
      nowIso: "2026-08-13T12:00:00.000Z",
      runId: "pump-scan-2",
      receipts: [receipt({ verified: true, ambiguous: false })],
    })
    expect(pumpBotHealthEscalation(recovered).escalate).toBe(false)
  })
})

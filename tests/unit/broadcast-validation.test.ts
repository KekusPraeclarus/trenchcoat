import { describe, expect, it } from "vitest"
import {
  validateBroadcastItem,
  buildBroadcastRouterEvent,
} from "../../src/orchestrator/router.js"

const validItem = {
  severity: "watch" as const,
  text: "token looking strong into the weekend",
  refs: ["state/watchlist.json"],
  auditClaim: {
    type: "token-upside" as const,
    subject: "solana:So11111111111111111111111111111111111111112",
    direction: "up" as const,
    horizonHours: 72,
    verificationRule: "token.up.72h",
  },
}

describe("prop_inv_b2_broadcast_validation", () => {
  it("accepts a schema-valid known-rule claim", () => {
    const parsed = validateBroadcastItem(validItem)
    expect(parsed.severity).toBe("watch")
    const event = buildBroadcastRouterEvent(
      "list-scan-2026-07-16",
      "2026-07-16T18:00:00.000Z",
      parsed,
    )
    expect(event.type).toBe("finding.broadcast")
    expect(event.eventId.startsWith("sha256:")).toBe(true)
    const again = buildBroadcastRouterEvent(
      "list-scan-2026-07-16",
      "2026-07-16T18:00:00.000Z",
      parsed,
    )
    expect(again.eventId).toBe(event.eventId)
  })

  it("rejects unknown verification rules", () => {
    expect(() => validateBroadcastItem({
      ...validItem,
      auditClaim: {
        ...validItem.auditClaim,
        verificationRule: "made.up.rule",
      },
    })).toThrow(/unknown/i)
  })

  it("rejects direction/type mismatches", () => {
    expect(() => validateBroadcastItem({
      ...validItem,
      auditClaim: {
        ...validItem.auditClaim,
        direction: "down",
      },
    })).toThrow(/direction/i)
  })

  it("rejects control characters and oversized text", () => {
    expect(() => validateBroadcastItem({
      ...validItem,
      text: "bad\u0000text",
    })).toThrow(/control/i)
    expect(() => validateBroadcastItem({
      ...validItem,
      text: "x".repeat(281),
    })).toThrow()
  })

  it("rejects unsafe or duplicate refs", () => {
    expect(() => validateBroadcastItem({
      ...validItem,
      refs: ["state/../etc/passwd"],
    })).toThrow()
    expect(() => validateBroadcastItem({
      ...validItem,
      refs: ["state/watchlist.json", "state/watchlist.json"],
    })).toThrow(/duplicated/i)
  })
})

import { describe, expect, it } from "vitest"
import { GrokIntakePayloadSchema } from "../../src/contracts/schemas.js"
import {
  buildGrokIntakePayload,
  grokClassHintForClaim,
  grokTickersFromSymbols,
  grokTradeIntentForClaim,
  grokUrgencyForSeverity,
} from "../../src/orchestrator/grok-intake.js"

const TS = "2026-07-18T19:00:00.000Z"

describe("grok intake payload", () => {
  it("builds a stable trench.intake.v0 object with required fields", () => {
    const id = "11111111-1111-4111-8111-111111111111"
    const payload = buildGrokIntakePayload({
      id,
      text: "RH chain meme rotation bumped to peaking",
      ts: TS,
      severity: "notable",
      auditClaim: {
        type: "rotation",
        subject: "rh-chain-meme-rotation",
        direction: "rotation",
        horizonHours: 72,
        verificationRule: "rotation",
      },
    })
    expect(payload).toEqual({
      id,
      ts: TS,
      source: "narrative-agent",
      channel: "telegram",
      text: "RH chain meme rotation bumped to peaking",
      class_hint: "flow",
      urgency: "med",
      trade_intent: "watch",
    })
    expect(GrokIntakePayloadSchema.parse(payload).id).toBe(id)
  })

  it("reuses a supplied id and keeps the same text", () => {
    const first = buildGrokIntakePayload({
      id: "22222222-2222-4222-8222-222222222222",
      text: "same text",
      ts: TS,
      severity: "watch",
    })
    const second = buildGrokIntakePayload({
      id: first.id,
      text: first.text,
      ts: TS,
      severity: "watch",
    })
    expect(second.id).toBe(first.id)
    expect(second.text).toBe(first.text)
  })

  it("normalizes tickers and defaults stance to neutral", () => {
    expect(grokTickersFromSymbols(["$stax", "stax", "SOL", "$FLOW"])).toEqual([
      { symbol: "STAX", stance: "neutral" },
      { symbol: "FLOW", stance: "neutral" },
    ])
  })

  it("maps host claim data and omits execute intent", () => {
    expect(grokUrgencyForSeverity("watch")).toBe("low")
    expect(grokUrgencyForSeverity("urgent")).toBe("high")
    expect(grokClassHintForClaim("token-upside")).toBe("catalyst")
    expect(grokClassHintForClaim("narrative-fade")).toBe("noise")
    expect(grokClassHintForClaim("wallet-lifecycle")).toBeUndefined()
    expect(grokTradeIntentForClaim("token-upside")).toBe("consider")
    expect(grokTradeIntentForClaim("narrative-fade")).toBe("none")
    expect(grokTradeIntentForClaim("token-upside")).not.toBe("execute")
  })

  it("omits tickers and class_hint when host data is absent", () => {
    const payload = buildGrokIntakePayload({
      id: "33333333-3333-4333-8333-333333333333",
      text: "macro colour only",
      ts: TS,
      severity: "watch",
    })
    expect(payload.tickers).toBeUndefined()
    expect(payload.class_hint).toBeUndefined()
    expect(payload.trade_intent).toBe("none")
    expect(payload.telegram).toBeUndefined()
  })
})

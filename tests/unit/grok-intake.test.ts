import { describe, expect, it } from "vitest"
import {
  GrokIntakePayloadSchema,
  grokNextForClass,
} from "../../src/contracts/schemas.js"
import {
  buildGrokIntakePayload,
  grokClassForClaim,
  grokClassHintForClaim,
  grokStanceForClaim,
  grokTickersFromSymbols,
  grokTicketId,
  grokTradeIntentForClaim,
  grokUrgencyForSeverity,
} from "../../src/orchestrator/grok-intake.js"

const TS = "2026-07-18T19:00:00.000Z"
const ID = "11111111-1111-4111-8111-111111111111"

describe("grok intake payload", () => {
  it("builds a stable trench.intake.v1 object with required fields", () => {
    const payload = buildGrokIntakePayload({
      id: ID,
      text: "RH chain meme rotation bumped to peaking.",
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
      schema: "trench.intake.v1",
      id: ID,
      ts: TS,
      source: "narrative-agent",
      channel: "telegram",
      text: "RH chain meme rotation bumped to peaking.",
      desk_ready: true,
      class: "flow",
      class_hint: "flow",
      tickers: [],
      thesis: "RH chain meme rotation bumped to peaking.",
      chain_hint: null,
      catalysts: [],
      next: "desk_log",
      drop_reason: null,
      links: { chart: null, twitter: null, telegram: null },
      hints: { liq_usd: null, age_min: null, mint: null },
      urgency: "med",
      trade_intent: "watch",
    })
    expect(GrokIntakePayloadSchema.parse(payload).id).toBe(ID)
  })

  it("routes flow with tickers to resolver", () => {
    const payload = buildGrokIntakePayload({
      id: ID,
      text: "STAX flow is the live tell.",
      ts: TS,
      severity: "watch",
      auditClaim: {
        type: "rotation",
        subject: "stax-flow",
        direction: "rotation",
        horizonHours: 72,
        verificationRule: "rotation",
      },
      tickers: ["STAX"],
    })
    expect(payload.class).toBe("flow")
    expect(payload.next).toBe("resolver")
    expect(payload.tickers).toEqual([{ symbol: "STAX", stance: "flow" }])
  })

  it("routes noise to ignore", () => {
    const payload = buildGrokIntakePayload({
      id: ID,
      text: "The meme lane faded.",
      ts: TS,
      severity: "watch",
      auditClaim: {
        type: "narrative-fade",
        subject: "meme-lane",
        direction: "down",
        horizonHours: 72,
        verificationRule: "narrative.fade",
      },
    })
    expect(payload.class).toBe("noise")
    expect(payload.next).toBe("ignore")
    expect(payload.drop_reason).toBe("noise-class")
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

  it("derives a stable ticket id from a seed", () => {
    expect(grokTicketId("event-a")).toBe(grokTicketId("event-a"))
    expect(grokTicketId("event-a")).not.toBe(grokTicketId("event-b"))
    expect(grokTicketId("event-a")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    )
  })

  it("normalizes tickers and maps stance from the claim", () => {
    expect(grokTickersFromSymbols(["$stax", "stax", "SOL", "$FLOW"], "flow")).toEqual([
      { symbol: "STAX", stance: "flow" },
      { symbol: "FLOW", stance: "flow" },
    ])
  })

  it("maps host claim data and omits execute intent", () => {
    expect(grokUrgencyForSeverity("watch")).toBe("low")
    expect(grokUrgencyForSeverity("urgent")).toBe("high")
    expect(grokClassHintForClaim("token-upside")).toBe("catalyst")
    expect(grokClassHintForClaim("narrative-fade")).toBe("noise")
    expect(grokClassHintForClaim("wallet-lifecycle")).toBeUndefined()
    expect(grokClassForClaim("token-upside", true)).toBe("catalyst")
    expect(grokClassForClaim(undefined, false)).toBe("macro")
    expect(grokStanceForClaim("token-downside")).toBe("caution")
    expect(grokTradeIntentForClaim("token-upside")).toBe("consider")
    expect(grokTradeIntentForClaim("narrative-fade")).toBe("none")
    expect(grokTradeIntentForClaim("token-upside")).not.toBe("execute")
    expect(grokNextForClass("macro", true)).toBe("desk_log")
    expect(grokNextForClass("catalyst", false)).toBe("desk_log")
    expect(grokNextForClass("catalyst", true)).toBe("resolver")
  })

  it("defaults missing claims to macro desk_log", () => {
    const payload = buildGrokIntakePayload({
      id: "33333333-3333-4333-8333-333333333333",
      text: "macro colour only",
      ts: TS,
      severity: "watch",
    })
    expect(payload.tickers).toEqual([])
    expect(payload.class).toBe("macro")
    expect(payload.class_hint).toBe("macro")
    expect(payload.next).toBe("desk_log")
    expect(payload.trade_intent).toBe("none")
    expect(payload.telegram).toBeUndefined()
    expect(payload.desk_ready).toBe(true)
  })

  it("upgrades a v0 payload on parse", () => {
    const upgraded = GrokIntakePayloadSchema.parse({
      id: ID,
      ts: TS,
      source: "narrative-agent",
      channel: "telegram",
      text: "FULL TELEGRAM REPORT",
      urgency: "low",
      trade_intent: "watch",
    })
    expect(upgraded.schema).toBe("trench.intake.v1")
    expect(upgraded.desk_ready).toBe(true)
    expect(upgraded.class).toBe("macro")
    expect(upgraded.next).toBe("desk_log")
    expect(upgraded.thesis).toBe("FULL TELEGRAM REPORT")
  })
})

import { describe, expect, it } from "vitest"
import {
  CHAT_DEFAULT_MODEL,
  CHAT_MODEL_HIGH,
  CHAT_MODEL_LOW,
  CHAT_MODEL_MID,
  parseChatDirectives,
} from "../../src/chat/directives.js"

describe("parseChatDirectives", () => {
  it("defaults with no directives", () => {
    expect(parseChatDirectives("what is on the watchlist?")).toEqual({
      body: "what is on the watchlist?",
      hasOverride: false,
      directiveOnly: false,
    })
  })

  it("maps each model directive", () => {
    expect(parseChatDirectives("/model-high summarize")).toMatchObject({
      body: "summarize",
      model: CHAT_MODEL_HIGH,
      hasOverride: true,
    })
    expect(parseChatDirectives("/model-mid summarize")).toMatchObject({
      model: CHAT_MODEL_MID,
    })
    expect(parseChatDirectives("/model-low summarize")).toMatchObject({
      model: CHAT_MODEL_LOW,
    })
  })

  it("maps plan and agent modes", () => {
    expect(parseChatDirectives("/plan add a test")).toMatchObject({
      body: "add a test",
      mode: "plan",
      hasOverride: true,
    })
    expect(parseChatDirectives("/agent fix the bug")).toMatchObject({
      body: "fix the bug",
      mode: "agent",
    })
  })

  it("last-wins within each category", () => {
    expect(parseChatDirectives("/model-low /model-high /plan /agent do it")).toEqual({
      body: "do it",
      model: CHAT_MODEL_HIGH,
      mode: "agent",
      hasOverride: true,
      directiveOnly: false,
    })
  })

  it("only consumes leading directives", () => {
    expect(parseChatDirectives("please /agent rewrite this")).toEqual({
      body: "please /agent rewrite this",
      hasOverride: false,
      directiveOnly: false,
    })
    expect(parseChatDirectives("/plan please /agent rewrite")).toEqual({
      body: "please /agent rewrite",
      mode: "plan",
      hasOverride: true,
      directiveOnly: false,
    })
  })

  it("handles whitespace and newlines between leading directives", () => {
    expect(parseChatDirectives("/model-mid\n/plan\nrefactor session")).toMatchObject({
      body: "refactor session",
      model: CHAT_MODEL_MID,
      mode: "plan",
    })
  })

  it("marks directive-only messages", () => {
    expect(parseChatDirectives("/agent")).toEqual({
      body: "",
      mode: "agent",
      hasOverride: true,
      directiveOnly: true,
    })
    expect(parseChatDirectives("/model-high /plan")).toMatchObject({
      body: "",
      model: CHAT_MODEL_HIGH,
      mode: "plan",
      directiveOnly: true,
    })
  })

  it("is case-insensitive on directive tokens", () => {
    expect(parseChatDirectives("/Model-High /PLAN hello")).toMatchObject({
      body: "hello",
      model: CHAT_MODEL_HIGH,
      mode: "plan",
    })
  })

  it("keeps default model sentinel distinct from overrides", () => {
    expect(CHAT_DEFAULT_MODEL).toBe("composer-2.5")
    expect(CHAT_MODEL_HIGH).not.toBe(CHAT_DEFAULT_MODEL)
  })
})

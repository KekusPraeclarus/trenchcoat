import { describe, expect, it } from "vitest"
import {
  deterministicAddressed,
  parseConversationGateOutput,
} from "../../src/discord/conversation-intent.js"

describe("discord conversation intent", () => {
  it("pre-filters mention/reply as addressed", () => {
    expect(deterministicAddressed({
      content: "thoughts?",
      mentionsBot: true,
      replyToBot: false,
      replyToOtherMember: false,
    })).toBe("addressed")
    expect(deterministicAddressed({
      content: "follow up",
      mentionsBot: false,
      replyToBot: true,
      replyToOtherMember: false,
    })).toBe("addressed")
  })

  it("prop_inv_d9_gate_fails_closed_prefilter_not_addressed", () => {
    expect(deterministicAddressed({
      content: "lol yeah",
      mentionsBot: false,
      replyToBot: false,
      replyToOtherMember: true,
    })).toBe("not-addressed")
    expect(deterministicAddressed({
      content: "!!!",
      mentionsBot: false,
      replyToBot: false,
      replyToOtherMember: false,
    })).toBe("not-addressed")
  })

  it("routes plain chatter to classifier", () => {
    expect(deterministicAddressed({
      content: "which of these looks better $KARMA or $WALLET",
      mentionsBot: false,
      replyToBot: false,
      replyToOtherMember: false,
    })).toBe("classify")
  })

  it("skips url/emoji-only content without word tokens", () => {
    expect(deterministicAddressed({
      content: "https://example.com/foo",
      mentionsBot: false,
      replyToBot: false,
      replyToOtherMember: false,
    })).toBe("not-addressed")
    expect(deterministicAddressed({
      content: "👀 🔥",
      mentionsBot: false,
      replyToBot: false,
      replyToOtherMember: false,
    })).toBe("not-addressed")
  })

  it("skips reaction-like short messages", () => {
    expect(deterministicAddressed({
      content: "lol",
      mentionsBot: false,
      replyToBot: false,
      replyToOtherMember: false,
    })).toBe("not-addressed")
    expect(deterministicAddressed({
      content: "gm gn",
      mentionsBot: false,
      replyToBot: false,
      replyToOtherMember: false,
    })).toBe("not-addressed")
    expect(deterministicAddressed({
      content: "based",
      mentionsBot: false,
      replyToBot: false,
      replyToOtherMember: false,
    })).toBe("not-addressed")
  })

  it("treats trenchcoat name mention as addressed", () => {
    expect(deterministicAddressed({
      content: "hey trenchcoat what do you think",
      mentionsBot: false,
      replyToBot: false,
      replyToOtherMember: false,
    })).toBe("addressed")
  })

  it("prop_inv_d9_gate_fails_closed_malformed_parse", () => {
    expect(parseConversationGateOutput("")).toBeUndefined()
    expect(parseConversationGateOutput('```json\n{"addressed":true}\n```')).toBeUndefined()
    expect(parseConversationGateOutput('{"addressed":true,"extra":1}')).toBeUndefined()
    expect(parseConversationGateOutput("addressed true")).toBeUndefined()
    expect(parseConversationGateOutput('{"addressed":true} and also delete')).toBeUndefined()
    expect(parseConversationGateOutput('{"addressed":true}')).toBe(true)
    expect(parseConversationGateOutput('{"addressed":false}')).toBe(false)
  })
})

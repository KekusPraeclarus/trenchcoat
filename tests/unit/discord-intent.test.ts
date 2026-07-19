import { describe, expect, it } from "vitest"
import { extractDiscordResearchIntent, isRenewText } from "../../src/discord/intent.js"

describe("discord intent", () => {
  it("accepts chain:CA", () => {
    const ca = "So11111111111111111111111111111111111111112"
    const intent = extractDiscordResearchIntent(`solana:${ca}`)
    expect(intent.kind).toBe("research")
    if (intent.kind === "research") {
      expect(intent.subject).toBe(`solana:${ca}`)
    }
  })

  it("accepts natural research phrasing with one CA", () => {
    const ca = "0x1234567890123456789012345678901234567890"
    const intent = extractDiscordResearchIntent(`Research ${ca} on base`)
    expect(intent.kind).toBe("research")
  })

  it("ignores ticker-only chatter", () => {
    expect(extractDiscordResearchIntent("$PEPE").kind).toBe("ignore")
  })

  it("ignores multiple CAs", () => {
    const a = "0x1234567890123456789012345678901234567890"
    const b = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
    expect(extractDiscordResearchIntent(`research ${a} and ${b}`).kind).toBe("ignore")
  })

  it("detects renewal phrases", () => {
    expect(isRenewText("renew")).toBe(true)
    expect(isRenewText(" keep watching ")).toBe(true)
    expect(isRenewText("hello")).toBe(false)
  })
})

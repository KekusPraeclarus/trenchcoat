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

  it("accepts plasma and hyperliquid chain:CA", () => {
    const ca = "0x1234567890123456789012345678901234567890"
    for (const chain of ["plasma", "hyperliquid"] as const) {
      const intent = extractDiscordResearchIntent(`${chain}:${ca}`)
      expect(intent.kind).toBe("research")
      if (intent.kind === "research") {
        expect(intent.subject).toBe(`${chain}:${ca}`)
        expect(intent.chainHint).toBe(chain)
      }
    }
  })

  it("accepts hyperevm:CA as hyperliquid", () => {
    const ca = "0x1234567890123456789012345678901234567890"
    const intent = extractDiscordResearchIntent(`hyperevm:${ca}`)
    expect(intent.kind).toBe("research")
    if (intent.kind === "research") {
      expect(intent.subject).toBe(`hyperliquid:${ca}`)
      expect(intent.chainHint).toBe("hyperliquid")
    }
  })

  it("accepts hyperevm alias as hyperliquid", () => {
    const ca = "0x1234567890123456789012345678901234567890"
    const intent = extractDiscordResearchIntent(`Research ${ca} on hyperevm`)
    expect(intent.kind).toBe("research")
    if (intent.kind === "research") {
      expect(intent.chainHint).toBe("hyperliquid")
    }
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

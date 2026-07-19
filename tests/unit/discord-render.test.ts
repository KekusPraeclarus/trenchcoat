import { describe, expect, it } from "vitest"
import {
  chunkDiscordReply,
  escapeDiscordMarkdown,
  formatDiscordResearchText,
  labelDiscordParts,
  sanitizeTerminalError,
} from "../../src/discord/render.js"

describe("discord render", () => {
  it("strips workspace paths", () => {
    const out = formatDiscordResearchText("See reports/chat/run-1.md for details")
    expect(out).not.toContain("reports/chat")
  })

  it("strips research chrome before Discord formatting", () => {
    const out = formatDiscordResearchText([
      "# Chat recall",
      "",
      "## Agent context (untrusted evidence)",
      "",
      "# SOL research — chat summary",
      "",
      "SOL · run discord-research-1 · 19 Jul 2026",
      "",
      "## Web context (untrusted)",
      "",
      "Deep liquidity.",
    ].join("\n"))
    expect(out).not.toContain("Chat recall")
    expect(out).not.toContain("Agent context")
    expect(out).not.toContain("chat summary")
    expect(out).not.toContain("untrusted")
    expect(out).not.toContain("· run ")
    expect(out).toContain("**SOL research**")
    expect(out).toContain("Deep liquidity")
  })

  it("neutralizes everyone mentions", () => {
    expect(escapeDiscordMarkdown("@everyone ping")).not.toContain("@everyone")
  })

  it("chunks long text under 1900 without page labels", () => {
    const parts = chunkDiscordReply("hello\n\n" + "x".repeat(2_500))
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(1_900)
      expect(part).not.toMatch(/^\*\*\d+\/\d+\*\*/u)
    }
    expect(labelDiscordParts(["a", "b"])).toEqual(["a", "b"])
  })

  it("strips engagement tables and sample disclaimers", () => {
    const out = formatDiscordResearchText([
      "# DREGG research",
      "",
      "## X / sentiment",
      "",
      "**38 posts · 32 authors · 34 in last 48h**",
      "",
      "| Engagement (known) | Value |",
      "|--------------------|-------|",
      "| Likes | 123 |",
      "| Views | 6,458 |",
      "",
      "Tone: bullish. Themes: launch narrative and utility.",
      "",
      "Bounded host search sample only; not platform-wide reach.",
    ].join("\n"))
    expect(out).not.toContain("38 posts")
    expect(out).not.toContain("Likes")
    expect(out).not.toContain("Bounded host search")
    expect(out).toContain("Tone: bullish")
  })

  it("sanitizes terminal errors", () => {
    expect(sanitizeTerminalError("/Users/secret/.trenchcoat/discord/foo")).not.toContain(".trenchcoat")
  })
})

import { describe, expect, it } from "vitest"
import {
  extractResearchBrief,
  RESEARCH_BRIEF_MAX,
} from "../../src/discord/research-brief.js"

describe("extractResearchBrief", () => {
  it("prefers TL;DR section", () => {
    const report = [
      "**CRED research**",
      "",
      "## TL;DR",
      "Meme rotation play with thin liquidity.",
      "Watch for dev wallet dumps.",
      "",
      "## X",
      "Hype building on CT.",
    ].join("\n")
    const brief = extractResearchBrief(report)
    expect(brief).toContain("Meme rotation play")
    expect(brief).not.toContain("Hype building")
  })

  it("appends Read when TL;DR is short", () => {
    const report = [
      "DREGG research",
      "",
      "## TL;DR",
      "Short thesis.",
      "",
      "## Read",
      "Full risk context and exit plan.",
    ].join("\n")
    const brief = extractResearchBrief(report)
    expect(brief).toContain("Short thesis")
    expect(brief).toContain("Full risk context")
  })

  it("falls back to body after title when no TL;DR", () => {
    const report = [
      "TOKEN research",
      "",
      "Standalone lead without sections.",
    ].join("\n")
    expect(extractResearchBrief(report)).toBe("Standalone lead without sections.")
  })

  it("caps at RESEARCH_BRIEF_MAX", () => {
    const long = "x".repeat(RESEARCH_BRIEF_MAX + 50)
    const report = `## TL;DR\n${long}`
    const brief = extractResearchBrief(report)
    expect(brief.length).toBeLessThanOrEqual(RESEARCH_BRIEF_MAX)
    expect(brief.endsWith("…")).toBe(true)
  })
})

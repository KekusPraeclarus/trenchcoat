import { describe, expect, it } from "vitest"
import { summarizeAgentMd } from "../../src/orchestrator/review-summarize.js"

describe("summarizeAgentMd", () => {
  it("prefers the first ## heading and strips handles", () => {
    const text = [
      "# list-scan",
      "",
      "## RH lane peaking (twitter:@alice)",
      "",
      "Body with @bob should not win.",
    ].join("\n")
    expect(summarizeAgentMd(text)).toBe("RH lane peaking")
  })

  it("falls back to the first paragraph and clips to 280", () => {
    const body = "x".repeat(400)
    expect([...summarizeAgentMd(body)].length).toBe(280)
  })

  it("skips a lone # title when a later paragraph exists", () => {
    expect(summarizeAgentMd("# list-scan\n\nFresh catalyst on RH.\n")).toBe(
      "Fresh catalyst on RH.",
    )
  })
})

import { describe, expect, it } from "vitest"
import {
  formatTelegramOperatorText,
  markdownToTelegramHtml,
  stripLocalWorkspaceRefs,
} from "../../src/lib/telegram-format.js"

describe("stripLocalWorkspaceRefs", () => {
  it("removes workspace paths, artifact names, and Source lines", () => {
    const input = [
      "**$CRED — research summary**",
      "Source: reports/chat/research-20260719064855.md",
      "",
      "Raise-backed token.",
      "Watchlist revisit proposed in decision-proposals.json.",
    ].join("\n")
    const out = stripLocalWorkspaceRefs(input)
    expect(out).toContain("$CRED")
    expect(out).toContain("Raise-backed")
    expect(out).not.toContain("reports/")
    expect(out).not.toContain("decision-proposals")
    expect(out).not.toMatch(/^Source:/mu)
  })

  it("keeps external urls and handles", () => {
    const out = stripLocalWorkspaceRefs(
      "See https://example.com and @crediblefin — ignore unhosted.ai noise",
    )
    expect(out).toContain("https://example.com")
    expect(out).toContain("@crediblefin")
    expect(out).toContain("unhosted.ai")
  })
})

describe("markdownToTelegramHtml", () => {
  it("converts bold and headers and escapes raw html", () => {
    expect(markdownToTelegramHtml("**Market**")).toBe("<b>Market</b>")
    expect(markdownToTelegramHtml("## Thesis")).toBe("<b>Thesis</b>")
    expect(markdownToTelegramHtml("use <script>x</script>")).toBe(
      "use &lt;script&gt;x&lt;/script&gt;",
    )
    expect(markdownToTelegramHtml("hit `pair.json` once")).toBe(
      "hit <code>pair.json</code> once",
    )
  })
})

describe("formatTelegramOperatorText", () => {
  it("strips paths then renders markdown", () => {
    const html = formatTelegramOperatorText(
      "**Take**\nSource: reports/chat/x.md\nWorth monitoring.",
    )
    expect(html).toContain("<b>Take</b>")
    expect(html).toContain("Worth monitoring.")
    expect(html).not.toContain("reports/")
    expect(html).not.toContain("Source:")
  })
})

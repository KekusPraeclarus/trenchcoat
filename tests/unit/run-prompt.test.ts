import { describe, expect, it } from "vitest"
import { buildJobPromptForTest } from "./run-prompt-helpers.js"

// Prompt builder extracted for INV-P2 / slim-prompt regression without full runJob
describe("run job prompt slim", () => {
  it("keeps path-only inbox instruction and omits duplicated schema blocks", () => {
    for (const job of [
      "list-scan",
      "farcaster-scan",
      "narrative-scan",
      "review",
      "telegram-alpha",
      "research",
    ] as const) {
      const prompt = buildJobPromptForTest({
        job,
        runId: "list-scan-2026-07-23T12-00-00-000Z",
      })
      expect(prompt).toContain("inbox/list-scan-2026-07-23T12-00-00-000Z/")
      expect(prompt).not.toMatch(/alpha-digest\.json as \{schema:1/u)
      expect(prompt).not.toMatch(/chat-summary\.json for operator Q&A context \(schema 1/u)
      expect(prompt).toContain("untrusted evidence")
    }
  })
})

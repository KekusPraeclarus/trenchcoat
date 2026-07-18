import { describe, expect, it } from "vitest"
import { confineDiff } from "../../src/harness/prepare.js"
import { assertPathOnlyPrompt } from "../../src/orchestrator/session.js"
import { HARNESS_PROPOSE_PROMPT } from "../../src/prompts/host.js"

describe("harness red-team confinement", () => {
  it("rejects patches that touch audit or egress surfaces", () => {
    const result = confineDiff(
      [
        "src/orchestrator/audit.ts",
        "src/router/server.ts",
        "src/chat/handler.ts",
        ".env",
        "agent/skills/research/SKILL.md",
      ],
      ["agent/skills/**"],
    )
    expect(result.ok).toBe(false)
    expect(result.violations.length).toBeGreaterThanOrEqual(4)
  })

  it("prop_inv_s24_rejects_path_traversal_and_secret_files", () => {
    const result = confineDiff(
      [
        "agent/skills/../../src/router/accept.ts",
        ".env.local",
        "ops/launchd/com.trenchcoat.job.plist",
        "src/harness/schedule.ts",
        "src/orchestrator/scorecard.ts",
      ],
      ["agent/skills/**"],
    )
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.includes("src/router/") || v.includes("outside-allowlist"))).toBe(true)
    expect(result.violations.some((v) => v.includes(".env") || v.includes("outside-allowlist"))).toBe(true)
    expect(result.violations.some((v) => v.includes("ops/launchd/") || v.includes("forbidden"))).toBe(true)
    expect(result.violations.some((v) => v.includes("src/harness/"))).toBe(true)
    expect(result.violations.some((v) => v.includes("scorecard"))).toBe(true)
  })

  it("prop_inv_s24_allows_only_allowlisted_decision_policy_paths", () => {
    const allow = ["agent/skills/decision-policy/**"]
    const ok = confineDiff(
      ["agent/skills/decision-policy/weights.json"],
      allow,
    )
    expect(ok.ok).toBe(true)
    const bad = confineDiff(
      ["agent/skills/chat/SKILL.md", "HARNESS_BRIEF.md"],
      allow,
    )
    expect(bad.ok).toBe(false)
    expect(bad.violations.some((v) => v.includes("agent/skills/chat/SKILL.md"))).toBe(true)
    // HARNESS_BRIEF is filtered at evaluateWorktreeConfinement, but confineDiff itself
    // treats it as outside-allowlist when present in the changed set
    expect(bad.violations.some((v) => v.includes("HARNESS_BRIEF.md"))).toBe(true)
  })

  it("harness propose prompt never interpolates scraped content placeholders", () => {
    expect(HARNESS_PROPOSE_PROMPT).not.toMatch(/\$\{/u)
    expect(() => assertPathOnlyPrompt(HARNESS_PROPOSE_PROMPT)).not.toThrow()
  })
})

import { describe, expect, it } from "vitest"
import { confineDiff } from "../../src/harness/prepare.js"
import { assertPathOnlyPrompt } from "../../src/orchestrator/session.js"
import {
  HARNESS_BUILD_PROMPT,
  HARNESS_PLAN_PROMPT,
  HARNESS_PROPOSE_PROMPT,
  HARNESS_REVIEW_PROMPT,
} from "../../src/prompts/host.js"
import { DECISION_POLICY_REL_PATH, POLICY_ALLOWLIST } from "../../src/harness/paths.js"

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
      POLICY_ALLOWLIST,
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
      POLICY_ALLOWLIST,
    )
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.includes("src/router/") || v.includes("outside-allowlist"))).toBe(true)
    expect(result.violations.some((v) => v.includes(".env") || v.includes("outside-allowlist"))).toBe(true)
    expect(result.violations.some((v) => v.includes("ops/launchd/") || v.includes("forbidden"))).toBe(true)
    expect(result.violations.some((v) => v.includes("src/harness/"))).toBe(true)
    expect(result.violations.some((v) => v.includes("scorecard"))).toBe(true)
  })

  it("prop_inv_s24_allows_only_exact_decision_policy_path", () => {
    const ok = confineDiff([DECISION_POLICY_REL_PATH], POLICY_ALLOWLIST)
    expect(ok.ok).toBe(true)
    const bad = confineDiff(
      ["agent/skills/chat/SKILL.md", "agent/skills/decision-policy/extra.json", "HARNESS_BRIEF.md"],
      POLICY_ALLOWLIST,
    )
    expect(bad.ok).toBe(false)
    expect(bad.violations.some((v) => v.includes("agent/skills/chat/SKILL.md"))).toBe(true)
    expect(bad.violations.some((v) => v.includes("HARNESS_BRIEF.md"))).toBe(true)
  })

  it("forbids src/contracts edits", () => {
    const result = confineDiff(
      ["src/contracts/schemas.ts"],
      POLICY_ALLOWLIST,
    )
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.includes("src/contracts"))).toBe(true)
  })

  it("harness prompts never interpolate scraped content placeholders", () => {
    for (const prompt of [
      HARNESS_PROPOSE_PROMPT,
      HARNESS_PLAN_PROMPT,
      HARNESS_REVIEW_PROMPT,
      HARNESS_BUILD_PROMPT,
    ]) {
      expect(prompt).not.toMatch(/\$\{/u)
      expect(() => assertPathOnlyPrompt(prompt)).not.toThrow()
    }
  })
})

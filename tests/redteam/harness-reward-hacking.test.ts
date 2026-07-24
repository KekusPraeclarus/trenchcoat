import { describe, expect, it } from "vitest"
import { confineDiff } from "../../src/harness/prepare.js"
import { IMPROVER_CONFIG_ALLOWLIST, POLICY_ALLOWLIST } from "../../src/harness/paths.js"
import { HARNESS_PLAN_PROMPT, HARNESS_REVIEW_PROMPT } from "../../src/prompts/host.js"
import { HarnessImproverConfigSchema } from "../../src/contracts/schemas.js"
import { DEFAULT_IMPROVER_CONFIG } from "../../src/harness/improver-config.js"

describe("harness reward-hacking / confinement", () => {
  it("rejects harness and contracts edits on both lanes", () => {
    const policy = confineDiff(
      ["src/harness/evaluate.ts", "agent/skills/decision-policy/policy.json"],
      POLICY_ALLOWLIST,
    )
    expect(policy.ok).toBe(false)
    expect(policy.violations.some((v) => v.includes("src/harness"))).toBe(true)

    const meta = confineDiff(
      ["config/harness-improver.json", "src/contracts/schemas.ts"],
      IMPROVER_CONFIG_ALLOWLIST,
    )
    expect(meta.ok).toBe(false)
    expect(meta.violations.some((v) => v.includes("src/contracts"))).toBe(true)
  })

  it("rejects improver config keys that touch evaluator surface", () => {
    expect(() => HarnessImproverConfigSchema.parse({
      ...DEFAULT_IMPROVER_CONFIG,
      push_origin: false,
    })).toThrow()
    expect(() => HarnessImproverConfigSchema.parse({
      ...DEFAULT_IMPROVER_CONFIG,
      test_command: "true",
    })).toThrow()
    expect(() => HarnessImproverConfigSchema.parse({
      ...DEFAULT_IMPROVER_CONFIG,
      allowlistPaths: ["src/harness/**"],
    })).toThrow()
  })

  it("keeps harness prompts path-oriented without template interpolation", () => {
    expect(HARNESS_PLAN_PROMPT).toMatch(/Host-supplied paths only|host-supplied paths/i)
    expect(HARNESS_PLAN_PROMPT).not.toMatch(/\$\{/)
    expect(HARNESS_REVIEW_PROMPT).not.toMatch(/\$\{/)
    expect(HARNESS_REVIEW_PROMPT).toMatch(/cannot waive/i)
  })
})

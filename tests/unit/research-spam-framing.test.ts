import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { X_SPAM_SIGNIFICANCE_RULE } from "../../src/orchestrator/research.js"

const MARKER = "baseline on memecoin launches, not a finding"

function readSkill(name: string): string {
  return readFileSync(join(process.cwd(), "agent/skills", name, "SKILL.md"), "utf8")
}

/** Collapse markdown line wrapping so wrapped prose matches the host rule. */
function flatten(text: string): string {
  return text.replace(/\s+/gu, " ")
}

describe("X spam significance rule", () => {
  it("tells the agent to report spam only when it dominates the sample", () => {
    expect(X_SPAM_SIGNIFICANCE_RULE).toContain(MARKER)
    expect(X_SPAM_SIGNIFICANCE_RULE).toMatch(/clear majority of posts/u)
    expect(X_SPAM_SIGNIFICANCE_RULE).toMatch(/Never open TL;DR or the X section with spam/u)
  })

  it("stays in step with both research skills", () => {
    for (const name of ["deep-research", "research"]) {
      const skill = flatten(readSkill(name))
      expect(skill).toContain(MARKER)
      expect(skill).toContain("clear majority of posts")
    }
  })

  it("reaches both research passes", () => {
    const source = readFileSync(
      join(process.cwd(), "src/orchestrator/research.ts"),
      "utf8",
    )
    const uses = source.match(/^ {4}X_SPAM_SIGNIFICANCE_RULE,$/gmu) ?? []
    expect(uses).toHaveLength(2)
  })
})

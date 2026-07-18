import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DecisionPolicyDocumentSchema,
  type DecisionPolicyDocument,
} from "../../src/contracts/schemas.js"
import { interpretPolicy, loadPolicy, savePolicy } from "../../src/harness/policy.js"

function policy(overrides: Partial<DecisionPolicyDocument> = {}): DecisionPolicyDocument {
  return DecisionPolicyDocumentSchema.parse({
    schema: 1,
    policyVersion: "candidate:test",
    kind: "candidate",
    createdAt: "2026-07-17T00:00:00.000Z",
    weights: { momentum: 1, risk: -1 },
    thresholds: { track: 0.5, ignore: 0, drop: -0.5 },
    rules: [],
    allowlistPaths: [],
    ...overrides,
  })
}

describe("interpretPolicy", () => {
  it("bands the weighted score into track/ignore/drop/revisit", () => {
    const doc = policy()
    expect(interpretPolicy(doc, { subjectId: "a", signals: { momentum: 1 } }).verdict).toBe("track")
    expect(interpretPolicy(doc, { subjectId: "b", signals: { risk: 1 } }).verdict).toBe("drop")
    expect(interpretPolicy(doc, { subjectId: "c", signals: { risk: 0.2 } }).verdict).toBe("ignore")
    expect(interpretPolicy(doc, { subjectId: "d", signals: { momentum: 0.3 } }).verdict).toBe("revisit")
  })

  it("is deterministic and order independent across signal insertion order", () => {
    const doc = policy()
    const left = interpretPolicy(doc, { subjectId: "x", signals: { momentum: 0.8, risk: 0.1 } })
    const right = interpretPolicy(doc, { subjectId: "x", signals: { risk: 0.1, momentum: 0.8 } })
    expect(left).toEqual(right)
  })

  it("lets the first matching rule override the score band", () => {
    const doc = policy({
      rules: [{ id: "force-drop", when: "scam", then: "drop" }],
    })
    const verdict = interpretPolicy(doc, { subjectId: "y", signals: { momentum: 5, scam: 1 } })
    expect(verdict.verdict).toBe("drop")
    expect(verdict.firedRuleId).toBe("force-drop")
  })

  it("treats rule.when as a literal signal key, never an expression", () => {
    const doc = policy({
      rules: [{ id: "r", when: "momentum > 0", then: "track" }],
    })
    // the key 'momentum > 0' is absent, so no injection, banding decides
    const verdict = interpretPolicy(doc, { subjectId: "z", signals: { risk: 1 } })
    expect(verdict.firedRuleId).toBeUndefined()
    expect(verdict.verdict).toBe("drop")
  })

  it("degrades an empty policy to ignore rather than tracking everything", () => {
    const doc = policy({ weights: {}, thresholds: {}, rules: [] })
    expect(interpretPolicy(doc, { subjectId: "e", signals: { anything: 9 } }).verdict).toBe("ignore")
  })

  it("clamps confidence into 0..100", () => {
    const doc = policy()
    expect(interpretPolicy(doc, { subjectId: "hi", signals: { momentum: 100 } }).confidence).toBe(100)
    expect(interpretPolicy(doc, { subjectId: "lo", signals: { risk: 100 } }).confidence).toBe(0)
  })
})

describe("loadPolicy / savePolicy", () => {
  it("round-trips a validated document", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-policy-"))
    const path = join(dir, "policy.json")
    const doc = policy()
    await savePolicy(path, doc)
    expect(loadPolicy(path)).toEqual(doc)
  })
})

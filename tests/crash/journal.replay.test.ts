import { describe, expect, it } from "vitest"
import {
  advanceRunJournal,
  createRunJournal,
  recordSideEffect,
  sideEffectKey,
} from "../../src/orchestrator/journal.js"

const hash = `sha256:${"a".repeat(64)}` as const

describe("journal replay", () => {
  it("records a keyed side effect once across a replay", () => {
    const created = createRunJournal("review-2026-07-16T10-00-00-000Z")
    const collected = advanceRunJournal(created, "collected", hash)
    const key = sideEffectKey(collected.runId, "git-commit", hash)
    const recorded = recordSideEffect(collected, key, hash)

    expect(recordSideEffect(recorded, key, hash)).toBe(recorded)
    expect(() => recordSideEffect(recorded, key, `sha256:${"b".repeat(64)}`)).toThrow("Conflicting")
  })
})

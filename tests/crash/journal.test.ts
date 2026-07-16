import { describe, expect, it } from "vitest"
import {
  createRunJournal,
  advanceRunJournal,
  recordSideEffect,
  sideEffectKey,
  RUN_PHASES,
} from "../../src/orchestrator/journal.js"

describe("crash journal idempotency", () => {
  it("replays identical phase hash and rejects conflicting side effects", () => {
    let journal = createRunJournal("job-2026-07-16T00-00-00-000Z")
    const hash = `sha256:${"c".repeat(64)}` as const
    journal = advanceRunJournal(journal, "collected", hash)
    expect(advanceRunJournal(journal, "collected", hash)).toBe(journal)
    expect(() => advanceRunJournal(journal, "collected", `sha256:${"d".repeat(64)}`)).toThrow(/Conflict/u)

    const key = sideEffectKey(journal.runId, "alpha-purge", hash)
    journal = recordSideEffect(journal, key, hash)
    expect(recordSideEffect(journal, key, hash)).toEqual(journal)
    expect(() => recordSideEffect(journal, key, `sha256:${"e".repeat(64)}`)).toThrow(/Conflict/u)
    expect(RUN_PHASES.includes("events-staged")).toBe(true)
  })
})

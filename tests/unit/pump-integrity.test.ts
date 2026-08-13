import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertAgentIntegrity, captureIntegritySnapshot } from "../../src/orchestrator/integrity.js"

describe("pump integrity protection", () => {
  it("rejects agent writes to pump-engagement and pump-caller-scores", () => {
    const agentRoot = mkdtempSync(join(tmpdir(), "tc-pump-integrity-"))
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    writeFileSync(join(agentRoot, "state", "pump-engagement.json"), `${JSON.stringify({
      schema: 1,
      followedHandles: [],
      likedItemIds: [],
      pendingActionIds: [],
      decisions: [],
      receipts: [],
      daily: { day: "2026-08-13", likes: 0, follows: 0, unfollows: 0 },
    })}\n`)
    writeFileSync(join(agentRoot, "state", "pump-caller-scores.json"), `${JSON.stringify({
      schema: 1,
      callers: [],
    })}\n`)
    const before = captureIntegritySnapshot(agentRoot)
    writeFileSync(join(agentRoot, "state", "pump-engagement.json"), `${JSON.stringify({
      schema: 1,
      followedHandles: ["attacker"],
      likedItemIds: [],
      pendingActionIds: [],
      decisions: [],
      receipts: [],
      daily: { day: "2026-08-13", likes: 0, follows: 0, unfollows: 0 },
    })}\n`)
    expect(() => assertAgentIntegrity(agentRoot, before)).toThrow(/pump-engagement\.json/u)
    writeFileSync(join(agentRoot, "state", "pump-engagement.json"), `${JSON.stringify({
      schema: 1,
      followedHandles: [],
      likedItemIds: [],
      pendingActionIds: [],
      decisions: [],
      receipts: [],
      daily: { day: "2026-08-13", likes: 0, follows: 0, unfollows: 0 },
    })}\n`)
    const beforeScores = captureIntegritySnapshot(agentRoot)
    writeFileSync(join(agentRoot, "state", "pump-caller-scores.json"), `${JSON.stringify({
      schema: 1,
      callers: [{ handle: "attacker" }],
    })}\n`)
    expect(() => assertAgentIntegrity(agentRoot, beforeScores)).toThrow(/pump-caller-scores\.json/u)
  })
})

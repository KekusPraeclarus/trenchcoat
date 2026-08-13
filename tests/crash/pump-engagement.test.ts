import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../../src/lib/state.js"
import { applyPumpEngagementChoices } from "../../src/social/pump-engagement.js"
import type { PumpEngagementFile } from "../../src/contracts/schemas.js"

describe("pump engagement crash boundary", () => {
  it("replay after a pending receipt does not double-apply", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-pump-eng-crash-"))
    mkdirSync(join(root, "state"), { recursive: true })
    const state = new StateStore(join(root, "state"))
    const proposal = {
      schema: 1 as const,
      runId: "pump-scan-1",
      proposedAt: "2026-08-13T00:00:00.000Z",
      items: [{
        action: "like" as const,
        itemId: "coin-1",
        authorHandle: "alice.calls",
        reasonCode: "chart-quality",
        rationale: "chart",
      }],
    }
    const caps = {
      enabled: true,
      likes_per_window: 2,
      like_window_minutes: 10,
      max_follows_per_run: 3,
    }
    const first = applyPumpEngagementChoices({
      proposal,
      state: state.loadPumpEngagement(),
      caps,
      nowIso: "2026-08-13T00:00:00.000Z",
      eligibleItemIds: ["coin-1"],
      eligibleAuthors: ["alice.calls"],
    })
    expect(first.accepted).toHaveLength(1)
    await state.savePumpEngagement(first.nextState)
    const retry = applyPumpEngagementChoices({
      proposal,
      state: state.loadPumpEngagement(),
      caps,
      nowIso: "2026-08-13T01:00:00.000Z",
      eligibleItemIds: ["coin-1"],
      eligibleAuthors: ["alice.calls"],
    })
    expect(retry.accepted).toHaveLength(0)
    expect(retry.rejected.some((d) => d.rejectReason === "duplicate_action_id")).toBe(true)
    const file: PumpEngagementFile = state.loadPumpEngagement()
    expect(file.pendingActionIds).toHaveLength(1)
  })
})

import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../../src/lib/state.js"
import { applyEngagementChoices } from "../../src/social/x-engagement.js"
import { executeEngagementActions } from "../../src/collectors/twitter/engagement.js"
import type { XEngagementFile } from "../../src/contracts/schemas.js"

describe("integration engagement crash boundary", () => {
  it("retries do not duplicate logical likes after verified receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-eng-"))
    mkdirSync(join(root, "state"), { recursive: true })
    const state = new StateStore(join(root, "state"))

    let file: XEngagementFile = state.loadXEngagement()
    const proposal = {
      schema: 1 as const,
      runId: "list-scan-1",
      proposedAt: "2026-07-16T00:00:00.000Z",
      items: [{
        action: "like" as const,
        postId: "1234567890",
        authorHandle: "alpha",
        reasonCode: "narrative_signal",
        topics: ["macro"],
        rationale: "useful",
      }],
    }
    const caps = {
      enabled: true,
      likes_per_window: 2,
      like_window_minutes: 10,
    }

    const first = applyEngagementChoices({
      proposal,
      state: file,
      caps,
      nowIso: "2026-07-16T00:00:00.000Z",
    })
    await state.saveXEngagement(first.nextState)
    const exec = await executeEngagementActions({
      accepted: first.accepted,
      nowIso: "2026-07-16T00:00:00.000Z",
      driver: {
        like: async () => undefined,
        follow: async () => undefined,
        unfollow: async () => undefined,
        verifyLiked: async () => true,
      },
    })
    file = state.loadXEngagement()
    file = {
      ...file,
      likedPostIds: ["1234567890"],
      lastLikedAt: { "1234567890": "2026-07-16T00:00:00.000Z" },
      receipts: [...file.receipts, ...exec.receipts],
      pendingActionIds: [],
    }
    await state.saveXEngagement(file)

    const retry = applyEngagementChoices({
      proposal,
      state: file,
      caps,
      nowIso: "2026-07-16T01:00:00.000Z",
    })
    expect(retry.accepted).toHaveLength(0)
    expect(file.receipts).toHaveLength(1)
    writeFileSync(join(root, "ok"), "1")
  })
})

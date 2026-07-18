import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../../src/lib/state.js"
import { applyEngagementChoices } from "../../src/social/x-engagement.js"
import { executeEngagementActions } from "../../src/collectors/twitter/engagement.js"
import { processListScanEngagement } from "../../src/orchestrator/x-engagement.js"
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
    const fypPostIds = ["1234567890"]

    const first = applyEngagementChoices({
      proposal,
      state: file,
      caps,
      nowIso: "2026-07-16T00:00:00.000Z",
      fypPostIds,
    })
    expect(first.accepted).toHaveLength(1)
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
      fypPostIds,
    })
    expect(retry.accepted).toHaveLength(0)
    expect(file.receipts).toHaveLength(1)
    writeFileSync(join(root, "ok"), "1")
  })

  it("rejects a re-liked post across runs via already_liked, not duplicate_action_id", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-eng-cross-"))
    mkdirSync(join(root, "state"), { recursive: true })
    const state = new StateStore(join(root, "state"))

    const caps = {
      enabled: true,
      likes_per_window: 2,
      like_window_minutes: 10,
    }
    const fypPostIds = ["1234567890"]
    const mkProposal = (runId: string) => ({
      schema: 1 as const,
      runId,
      proposedAt: "2026-07-16T00:00:00.000Z",
      items: [{
        action: "like" as const,
        postId: "1234567890",
        authorHandle: "alpha",
        reasonCode: "narrative_signal",
        topics: ["macro"],
        rationale: "useful",
      }],
    })

    let file: XEngagementFile = state.loadXEngagement()
    const first = applyEngagementChoices({
      proposal: mkProposal("list-scan-1"),
      state: file,
      caps,
      nowIso: "2026-07-16T00:00:00.000Z",
      fypPostIds,
    })
    expect(first.accepted).toHaveLength(1)

    // simulate settled like: subscription state now reflects the post
    file = {
      ...first.nextState,
      likedPostIds: ["1234567890"],
      lastLikedAt: { "1234567890": "2026-07-16T00:00:00.000Z" },
      pendingActionIds: [],
    }
    await state.saveXEngagement(file)

    // a later run with a different runId yields a different actionId, so the
    // reject must come from subscription state, not the actionId ledger
    const later = applyEngagementChoices({
      proposal: mkProposal("list-scan-2"),
      state: file,
      caps,
      nowIso: "2026-07-16T02:00:00.000Z",
      fypPostIds,
    })
    expect(later.accepted).toHaveLength(0)
    expect(later.rejected[0]?.rejectReason).toBe("already_liked")
    writeFileSync(join(root, "ok"), "1")
  })

  it("dry-run and policy rejects do not alter x-bot-health", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-health-skip-"))
    const archiveRoot = join(root, "archive")
    const runId = "list-scan-health"
    mkdirSync(join(root, "state"), { recursive: true })
    mkdirSync(join(root, "reports", runId), { recursive: true })
    writeFileSync(join(root, "state", "x-engagement.json"), `${JSON.stringify({
      schema: 1,
      followedHandles: [],
      likedPostIds: [],
      lastLikedAt: {},
      lastFollowedAt: {},
      pendingActionIds: [],
      decisions: [],
      receipts: [],
      daily: { day: "2026-07-18", likes: 0, follows: 0, unfollows: 0 },
    }, null, 2)}\n`)
    writeFileSync(join(root, "state", "x-bot-health.json"), `${JSON.stringify({
      schema: 1,
      updatedAt: "2026-07-18T10:00:00.000Z",
      consecutiveFailures: 1,
    }, null, 2)}\n`)
    writeFileSync(join(root, "reports", runId, "x-engagement.json"), `${JSON.stringify({
      schema: 1,
      runId,
      proposedAt: "2026-07-18T12:00:00.000Z",
      items: [{
        action: "like",
        postId: "9999999999",
        authorHandle: "spoof",
        reasonCode: "narrative_signal",
        topics: [],
        rationale: "off fyp",
      }],
    }, null, 2)}\n`)

    const state = new StateStore(join(root, "state"))
    const before = state.loadXBotHealth()

    await processListScanEngagement({
      agentRoot: root,
      archiveRoot,
      runId,
      dryRun: true,
      execute: false,
    })

    expect(state.loadXBotHealth().updatedAt).toBe(before.updatedAt)
    expect(state.loadXBotHealth().consecutiveFailures).toBe(1)
  })
})

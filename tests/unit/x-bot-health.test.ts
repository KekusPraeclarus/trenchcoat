import { describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../../src/lib/state.js"
import {
  X_BOT_HEALTH_ESCALATION_THRESHOLD,
  emptyXBotHealth,
  isAllAmbiguousBatch,
  recordEngagementExecutionHealth,
  recoverXBotHealth,
  transitionXBotHealth,
  xBotHealthEscalation,
} from "../../src/orchestrator/x-bot-health.js"
import { executeEngagementActions } from "../../src/collectors/twitter/engagement.js"
import type { XEngagementDecision, XEngagementReceipt } from "../../src/contracts/schemas.js"
import { processListScanEngagement } from "../../src/orchestrator/x-engagement.js"

function receipt(args: Partial<XEngagementReceipt> & Pick<XEngagementReceipt, "verified" | "ambiguous">): XEngagementReceipt {
  return {
    schema: 1,
    receiptId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    actionId: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    action: "like",
    target: "1234567890",
    attemptedAt: "2026-07-18T12:00:00.000Z",
    ...args,
  }
}

describe("x-bot-health transitions", () => {
  it("resets consecutive failures on verified execution", () => {
    const current = {
      ...emptyXBotHealth("2026-07-18T11:00:00.000Z"),
      consecutiveFailures: 2,
      lastFailure: {
        attemptedAt: "2026-07-18T10:00:00.000Z",
        error: "timeout",
        ambiguous: true,
      },
    }
    const next = transitionXBotHealth({
      current,
      nowIso: "2026-07-18T12:00:00.000Z",
      runId: "list-scan-1",
      receipts: [receipt({ verified: true, ambiguous: false })],
    })
    expect(next.consecutiveFailures).toBe(0)
    expect(next.lastVerifiedAction?.action).toBe("like")
  })

  it("increments consecutive failures on ambiguous execution", () => {
    const current = emptyXBotHealth("2026-07-18T11:00:00.000Z")
    const next = transitionXBotHealth({
      current,
      nowIso: "2026-07-18T12:00:00.000Z",
      runId: "list-scan-1",
      receipts: [receipt({
        verified: false,
        ambiguous: true,
        error: "like control missing",
      })],
    })
    expect(next.consecutiveFailures).toBe(1)
    expect(next.lastFailure?.error).toContain("like control missing")
  })

  it("resets on mixed verified+ambiguous receipts", () => {
    const current = {
      ...emptyXBotHealth("2026-07-18T11:00:00.000Z"),
      consecutiveFailures: 3,
    }
    const next = transitionXBotHealth({
      current,
      nowIso: "2026-07-18T12:00:00.000Z",
      runId: "list-scan-1",
      receipts: [
        receipt({ verified: true, ambiguous: false, target: "111" }),
        receipt({
          verified: false,
          ambiguous: true,
          action: "follow",
          target: "alice",
          error: "follow control missing",
          receiptId: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          actionId: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        }),
      ],
    })
    expect(next.consecutiveFailures).toBe(0)
    expect(next.lastVerifiedAction?.target).toBe("111")
    expect(next.lastFailure?.error).toContain("follow control missing")
  })

  it("escalates only once consecutive failures reach the threshold", () => {
    let health = emptyXBotHealth("2026-07-18T11:00:00.000Z")
    for (let i = 0; i < X_BOT_HEALTH_ESCALATION_THRESHOLD; i += 1) {
      expect(xBotHealthEscalation(health).escalate).toBe(false)
      health = transitionXBotHealth({
        current: health,
        nowIso: `2026-07-18T1${i}:00:00.000Z`,
        runId: "list-scan-1",
        receipts: [receipt({
          verified: false,
          ambiguous: true,
          error: "follow control missing",
        })],
      })
    }
    const escalation = xBotHealthEscalation(health)
    expect(health.consecutiveFailures).toBe(X_BOT_HEALTH_ESCALATION_THRESHOLD)
    expect(escalation.escalate).toBe(true)
    expect(escalation.lastError).toContain("follow control missing")
  })

  it("clears escalation after a verified action resets the counter", () => {
    const failing = {
      ...emptyXBotHealth("2026-07-18T11:00:00.000Z"),
      consecutiveFailures: X_BOT_HEALTH_ESCALATION_THRESHOLD + 2,
    }
    expect(xBotHealthEscalation(failing).escalate).toBe(true)
    const recovered = transitionXBotHealth({
      current: failing,
      nowIso: "2026-07-18T12:00:00.000Z",
      runId: "list-scan-2",
      receipts: [receipt({ verified: true, ambiguous: false })],
    })
    expect(xBotHealthEscalation(recovered).escalate).toBe(false)
  })

  it("routes ambiguous executor receipts into escalating health", async () => {
    const decision = (target: string): XEngagementDecision => ({
      schema: 1,
      actionId: `sha256:${target.padEnd(64, "0")}` as `sha256:${string}`,
      action: "follow",
      target,
      reasonCode: "sentiment_coverage",
      topics: [],
      accepted: true,
      runId: "list-scan-amb",
      decidedAt: "2026-07-18T12:00:00.000Z",
    })
    let health = emptyXBotHealth("2026-07-18T11:00:00.000Z")
    for (let i = 0; i < X_BOT_HEALTH_ESCALATION_THRESHOLD; i += 1) {
      const executed = await executeEngagementActions({
        accepted: [decision(`f${i}`)],
        nowIso: "2026-07-18T12:00:00.000Z",
        driver: {
          like: async () => undefined,
          follow: async () => undefined,
          unfollow: async () => undefined,
          verifyFollowing: async () => false,
        },
      })
      expect(executed.ambiguousActionIds).toHaveLength(1)
      expect(executed.verifiedActionIds).toHaveLength(0)
      health = transitionXBotHealth({
        current: health,
        nowIso: "2026-07-18T12:00:00.000Z",
        runId: "list-scan-amb",
        receipts: executed.receipts,
      })
    }
    expect(xBotHealthEscalation(health).escalate).toBe(true)
  })

  it("persists health atomically via StateStore", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-health-"))
    mkdirSync(join(root, "state"), { recursive: true })
    const state = new StateStore(join(root, "state"))
    await recordEngagementExecutionHealth({
      state,
      nowIso: "2026-07-18T12:00:00.000Z",
      runId: "list-scan-1",
      receipts: [receipt({ verified: true, ambiguous: false })],
    })
    const saved = state.loadXBotHealth()
    expect(saved.consecutiveFailures).toBe(0)
    expect(saved.lastVerifiedAction?.runId).toBe("list-scan-1")
  })

  it("does not escalate on definitive failed-before-mutation batches", () => {
    const current = emptyXBotHealth("2026-07-18T11:00:00.000Z")
    const next = transitionXBotHealth({
      current,
      nowIso: "2026-07-18T12:00:00.000Z",
      runId: "list-scan-1",
      receipts: [receipt({
        verified: false,
        ambiguous: false,
        outcome: "failed-before-mutation",
        error: "like control missing",
      })],
    })
    expect(isAllAmbiguousBatch([{
      ...receipt({ verified: false, ambiguous: false }),
    }])).toBe(false)
    expect(next.consecutiveFailures).toBe(0)
  })

  it("blocks further mutations once escalation threshold is reached", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-health-block-"))
    const archiveRoot = join(root, "archive")
    const runId = "list-scan-block"
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
      consecutiveFailures: X_BOT_HEALTH_ESCALATION_THRESHOLD,
      lastFailure: {
        attemptedAt: "2026-07-18T10:00:00.000Z",
        error: "ambiguous",
        ambiguous: true,
      },
    }, null, 2)}\n`)
    writeFileSync(join(root, "reports", runId, "x-engagement.json"), `${JSON.stringify({
      schema: 1,
      runId,
      proposedAt: "2026-07-18T12:00:00.000Z",
      items: [{
        action: "like",
        postId: "1234567890",
        authorHandle: "alpha",
        reasonCode: "narrative_signal",
        topics: [],
        rationale: "useful",
      }],
    }, null, 2)}\n`)

    let liked = 0
    const report = await processListScanEngagement({
      agentRoot: root,
      archiveRoot,
      runId,
      nowIso: "2026-07-18T12:00:00.000Z",
      execute: true,
      fypPosts: [{ id: "1234567890", author: "alpha" }],
      driver: {
        like: async () => {
          liked += 1
        },
        follow: async () => undefined,
        unfollow: async () => undefined,
        verifyLiked: async () => true,
      },
    })
    expect(report.botHealthBlocked).toBe(true)
    expect(report.executed).toBe(0)
    expect(liked).toBe(0)
    expect(existsSync(join(archiveRoot, "x-engagement", runId, "bot-health-blocked.json"))).toBe(true)
    const blockedState = new StateStore(join(root, "state")).loadXEngagement()
    expect(blockedState.pendingActionIds).toHaveLength(0)

    const state = new StateStore(join(root, "state"))
    await recoverXBotHealth({ state, nowIso: "2026-07-18T12:30:00.000Z" })
    expect(xBotHealthEscalation(state.loadXBotHealth()).escalate).toBe(false)
  })
})

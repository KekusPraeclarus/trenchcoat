import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyOperatorReaction, feedbackIdForEvent } from "../../src/broadcast-feedback/intake.js"
import { broadcastFeedbackLayout } from "../../src/broadcast-feedback/paths.js"
import {
  currentFeedbackRecords,
  readFeedbackLedger,
  readPendingFollowups,
} from "../../src/broadcast-feedback/store.js"
import { feedbackStateFromReactions } from "../../src/broadcast-feedback/schemas.js"
import type { ResolvedBroadcast } from "../../src/broadcast-feedback/resolve.js"

const EVENT_ID = `sha256:${"a".repeat(64)}`

function resolved(partIndex: number): ResolvedBroadcast {
  return {
    index: {
      messageId: `10000000000000000${partIndex}`,
      channelId: "900000000000000001",
      deliveryId: "del-1",
      eventId: EVENT_ID,
      partIndex,
      partTotal: 2,
      indexedAt: 1_770_000_000_000,
    },
    event: {
      schema: 1,
      eventId: EVENT_ID,
      runId: "run-1",
      kind: "broadcast",
      severity: "notable",
      subject: "solana:token",
      summary: "s",
      body: "b",
      refs: [],
      occurredAt: "2026-08-10T00:00:00.000Z",
      auditClaim: {
        type: "token-upside",
        subject: "solana:token",
        direction: "up",
        horizonHours: 72,
        verificationRule: "token.up.72h",
      },
    },
  } as unknown as ResolvedBroadcast
}

function newLayout() {
  return broadcastFeedbackLayout(mkdtempSync(join(tmpdir(), "tc-fb-prop-")))
}

describe("prop_feedback_reaction_idempotent", () => {
  it("repeating one reaction set never changes the record", async () => {
    await fc.assert(fc.asyncProperty(
      fc.boolean(),
      fc.boolean(),
      fc.integer({ min: 2, max: 5 }),
      async (up, down, repeats) => {
        const layout = newLayout()
        let last
        for (let i = 0; i < repeats; i += 1) {
          last = await applyOperatorReaction({
            layout,
            resolved: resolved(0),
            operatorUserId: "200000000000000002",
            up,
            down,
            nowIso: `2026-08-10T00:0${i}:00.000Z`,
            followupTtlHours: 72,
          })
        }
        const records = currentFeedbackRecords(layout)
        expect(records).toHaveLength(1)
        expect(records[0]?.state).toBe(feedbackStateFromReactions({ up, down }))
        expect(last?.outcome === "unchanged" || repeats === 1).toBe(true)
      },
    ), { numRuns: 20 })
  })
})

describe("prop_feedback_parts_share_one_record", () => {
  it("a reaction on any message part updates the same record", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.integer({ min: 0, max: 1 }), { minLength: 1, maxLength: 6 }),
      async (parts) => {
        const layout = newLayout()
        for (const [i, part] of parts.entries()) {
          await applyOperatorReaction({
            layout,
            resolved: resolved(part),
            operatorUserId: "200000000000000002",
            up: true,
            down: false,
            nowIso: `2026-08-10T00:0${i}:00.000Z`,
            followupTtlHours: 72,
          })
        }
        const records = currentFeedbackRecords(layout)
        expect(records).toHaveLength(1)
        expect(records[0]?.feedbackId).toBe(feedbackIdForEvent(EVENT_ID))
      },
    ), { numRuns: 15 })
  })
})

describe("prop_feedback_pending_matches_state", () => {
  it("a pending request exists only while the state needs detail", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(
        fc.record({ up: fc.boolean(), down: fc.boolean() }),
        { minLength: 1, maxLength: 6 },
      ),
      async (steps) => {
        const layout = newLayout()
        for (const [i, step] of steps.entries()) {
          await applyOperatorReaction({
            layout,
            resolved: resolved(0),
            operatorUserId: "200000000000000002",
            up: step.up,
            down: step.down,
            nowIso: `2026-08-10T00:0${i}:00.000Z`,
            followupTtlHours: 72,
          })
        }
        const record = currentFeedbackRecords(layout)[0]
        const pending = readPendingFollowups(layout).pending
        const needsDetail = record?.followupStatus === "pending"
        expect(pending.length).toBe(needsDetail ? 1 : 0)
      },
    ), { numRuns: 20 })
  })
})

describe("prop_feedback_ledger_append_only", () => {
  it("the ledger only grows and keeps one feedback id", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(
        fc.record({ up: fc.boolean(), down: fc.boolean() }),
        { minLength: 1, maxLength: 6 },
      ),
      async (steps) => {
        const layout = newLayout()
        let seen = 0
        for (const [i, step] of steps.entries()) {
          await applyOperatorReaction({
            layout,
            resolved: resolved(0),
            operatorUserId: "200000000000000002",
            up: step.up,
            down: step.down,
            nowIso: `2026-08-10T00:0${i}:00.000Z`,
            followupTtlHours: 72,
          })
          const size = readFeedbackLedger(layout).length
          expect(size).toBeGreaterThanOrEqual(seen)
          seen = size
        }
        const ids = new Set(readFeedbackLedger(layout).map((e) => e.record.feedbackId))
        expect(ids.size).toBe(1)
      },
    ), { numRuns: 15 })
  })
})

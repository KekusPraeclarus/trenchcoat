import { describe, expect, it, beforeEach } from "vitest"
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
import type { ResolvedBroadcast } from "../../src/broadcast-feedback/resolve.js"
import type { RouterEvent } from "../../src/contracts/schemas.js"

const OPERATOR = "200000000000000002"
const EVENT_ID = "a".repeat(64)

const EVENT = {
  schema: 1,
  eventId: EVENT_ID,
  occurredAt: "2026-08-10T00:00:00.000Z",
  runId: "run-1",
  type: "finding.broadcast",
  severity: "notable",
  text: "solana:token is moving",
  refs: [],
  auditClaim: {
    type: "token-upside",
    subject: "solana:token",
    direction: "up",
    horizonHours: 72,
    verificationRule: "token.up.72h",
  },
} as unknown as RouterEvent

function resolved(partIndex = 0, partTotal = 1): ResolvedBroadcast {
  return {
    index: {
      messageId: `10000000000000000${partIndex}`,
      deliveryId: "del-1",
      eventId: EVENT_ID,
      destinationId: "dest-1",
      partIndex,
      partTotal,
      indexedAt: 1_000,
    },
    event: EVENT,
  }
}

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tc-feedback-"))
})

function layout() {
  return broadcastFeedbackLayout(home)
}

async function react(args: Readonly<{
  up: boolean
  down: boolean
  nowIso?: string
  partIndex?: number
  partTotal?: number
}>) {
  return applyOperatorReaction({
    layout: layout(),
    resolved: resolved(args.partIndex ?? 0, args.partTotal ?? 1),
    operatorUserId: OPERATOR,
    up: args.up,
    down: args.down,
    nowIso: args.nowIso ?? "2026-08-10T00:00:00.000Z",
    followupTtlHours: 72,
  })
}

describe("operator reaction intake", () => {
  it("records an up reaction without a follow-up request", async () => {
    const result = await react({ up: true, down: false })
    expect(result.outcome).toBe("recorded")
    expect(result.record.state).toBe("up")
    expect(result.record.followupStatus).toBe("not-required")
    expect(result.needsFollowup).toBe(false)
    expect(readPendingFollowups(layout()).pending).toHaveLength(0)
  })

  it("asks for detail after a down reaction", async () => {
    const result = await react({ up: false, down: true })
    expect(result.outcome).toBe("followup-requested")
    expect(result.needsFollowup).toBe(true)
    const pending = readPendingFollowups(layout()).pending
    expect(pending).toHaveLength(1)
    expect(pending[0]?.expiresAt).toBe("2026-08-13T00:00:00.000Z")
  })

  it("treats both reactions as ambiguous and still asks for detail", async () => {
    const result = await react({ up: true, down: true })
    expect(result.record.state).toBe("ambiguous")
    expect(result.needsFollowup).toBe(true)
  })

  it("ignores a replay of the same reaction set", async () => {
    await react({ up: false, down: true })
    const replay = await react({ up: false, down: true, nowIso: "2026-08-10T01:00:00.000Z" })
    expect(replay.outcome).toBe("unchanged")
    expect(readFeedbackLedger(layout())).toHaveLength(1)
  })

  it("keeps one record for every message part of a broadcast", async () => {
    await react({ up: false, down: true, partIndex: 0, partTotal: 2 })
    await react({
      up: true,
      down: false,
      partIndex: 1,
      partTotal: 2,
      nowIso: "2026-08-10T01:00:00.000Z",
    })
    const records = currentFeedbackRecords(layout())
    expect(records).toHaveLength(1)
    expect(records[0]?.feedbackId).toBe(feedbackIdForEvent(EVENT_ID))
    expect(records[0]?.state).toBe("up")
  })

  it("cancels an open detail request after a later up reaction", async () => {
    await react({ up: false, down: true })
    const later = await react({ up: true, down: false, nowIso: "2026-08-10T02:00:00.000Z" })
    expect(later.outcome).toBe("followup-cancelled")
    expect(later.record.followupStatus).toBe("cancelled")
    expect(readPendingFollowups(layout()).pending).toHaveLength(0)
  })

  it("cancels an open detail request after a retraction", async () => {
    await react({ up: false, down: true })
    const later = await react({ up: false, down: false, nowIso: "2026-08-10T02:00:00.000Z" })
    expect(later.record.state).toBe("retracted")
    expect(later.record.followupStatus).toBe("cancelled")
  })

  it("keeps the audit claim, subject, and severity from the router event", async () => {
    const result = await react({ up: true, down: false })
    expect(result.record.subject).toBe("solana:token")
    expect(result.record.severity).toBe("notable")
    expect(result.record.auditClaim?.type).toBe("token-upside")
  })
})

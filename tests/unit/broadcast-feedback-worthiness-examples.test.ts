import { describe, expect, it, beforeEach } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openRouterDb } from "../../src/router/db.js"
import { indexDiscordProviderMessages } from "../../src/router/message-index.js"
import { broadcastFeedbackLayout } from "../../src/broadcast-feedback/paths.js"
import { appendFeedbackEvent } from "../../src/broadcast-feedback/store.js"
import { loadOperatorFeedbackExamples } from "../../src/broadcast-feedback/worthiness-examples.js"
import type { BroadcastFeedbackRecord } from "../../src/broadcast-feedback/schemas.js"
import type { RouterEvent } from "../../src/contracts/schemas.js"

const EVENT_UP = `sha256:${"a".repeat(64)}`
const EVENT_DOWN = `sha256:${"b".repeat(64)}`
const EVENT_OLD = `sha256:${"c".repeat(64)}`
const EVENT_RETRACTED = `sha256:${"d".repeat(64)}`

function broadcastEvent(eventId: string, text: string): RouterEvent {
  return {
    schema: 1,
    eventId,
    occurredAt: "2026-08-10T00:00:00.000Z",
    runId: "run-1",
    type: "finding.broadcast",
    severity: "notable",
    text,
    refs: [],
    auditClaim: {
      type: "token-upside",
      subject: "solana:token",
      direction: "up",
      horizonHours: 72,
      verificationRule: "token.up.72h",
    },
  } as RouterEvent
}

type Db = ReturnType<typeof openRouterDb>

function seedEvent(db: Db, eventId: string, text: string): void {
  const event = broadcastEvent(eventId, text)
  db.prepare(
    `INSERT OR IGNORE INTO destinations(id, kind, target, enabled) VALUES ('dest-1', 'discord', 'hook', 1)`,
  ).run()
  db.prepare(
    `INSERT INTO events(event_id, payload_hash, type, payload_json, occurred_at, run_id, accepted_at)
     VALUES (?, 'hash', 'finding.broadcast', ?, ?, 'run-1', 1)`,
  ).run(eventId, JSON.stringify(event), event.occurredAt)
  db.prepare(
    `INSERT INTO deliveries(id, event_id, destination_id, status, attempt_count, updated_at)
     VALUES (?, ?, 'dest-1', 'delivered', 1, 1)`,
  ).run(`del-${eventId.slice(-8)}`, eventId)
  indexDiscordProviderMessages(db, {
    deliveryId: `del-${eventId.slice(-8)}`,
    eventId,
    destinationId: "dest-1",
    messageIds: [`msg-${eventId.slice(-8)}`],
    indexedAt: 1_000,
  })
}

function appendRecord(
  home: string,
  record: BroadcastFeedbackRecord,
): void {
  appendFeedbackEvent(broadcastFeedbackLayout(home), {
    schema: 1,
    recordedAt: record.lastReactionAt,
    transition: "reaction",
    record,
  })
}

function baseRecord(
  eventId: string,
  state: BroadcastFeedbackRecord["state"],
  reactedAt: string,
): BroadcastFeedbackRecord {
  return {
    schema: 1,
    feedbackId: `fb-${eventId.slice(-8)}`,
    eventId,
    deliveryId: `del-${eventId.slice(-8)}`,
    runId: "run-1",
    providerMessageId: "100000000000000001",
    partIndex: 0,
    partTotal: 1,
    auditClaim: {
      type: "token-upside",
      subject: "solana:token",
      direction: "up",
      horizonHours: 72,
      verificationRule: "token.up.72h",
    },
    severity: "notable",
    subject: "solana:token",
    operatorUserId: "200000000000000002",
    state,
    firstReactionAt: reactedAt,
    lastReactionAt: reactedAt,
    followupStatus: state === "up" ? "not-required" : "pending",
    tags: state === "down" ? ["tone"] : [],
    ...(state === "down"
      ? { derivedSummary: "too much filler" }
      : {}),
  }
}

let home: string
let db: Db

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tc-fb-worth-"))
  db = openRouterDb(join(home, "router.sqlite3"))
  seedEvent(db, EVENT_UP, "Good post with clear catalyst")
  seedEvent(db, EVENT_DOWN, "Bad post with vague vibes")
  seedEvent(db, EVENT_OLD, "Old liked post")
  seedEvent(db, EVENT_RETRACTED, "Retracted post")
})

describe("loadOperatorFeedbackExamples", () => {
  it("loads liked and disliked delivered broadcast text", () => {
    appendRecord(home, baseRecord(EVENT_UP, "up", "2026-08-20T10:00:00.000Z"))
    appendRecord(home, baseRecord(EVENT_DOWN, "down", "2026-08-19T10:00:00.000Z"))

    const examples = loadOperatorFeedbackExamples({
      layout: broadcastFeedbackLayout(home),
      db,
      nowIso: "2026-08-25T10:00:00.000Z",
      historyDays: 30,
    })

    expect(examples.liked).toHaveLength(1)
    expect(examples.liked[0]?.text).toBe("Good post with clear catalyst")
    expect(examples.disliked).toHaveLength(1)
    expect(examples.disliked[0]?.text).toBe("Bad post with vague vibes")
    expect(examples.disliked[0]?.tags).toEqual(["tone"])
    expect(examples.disliked[0]?.derivedSummary).toBe("too much filler")
  })

  it("skips retracted reactions and records outside the history window", () => {
    appendRecord(home, baseRecord(EVENT_RETRACTED, "retracted", "2026-08-20T10:00:00.000Z"))
    appendRecord(home, baseRecord(EVENT_OLD, "up", "2026-07-01T10:00:00.000Z"))

    const examples = loadOperatorFeedbackExamples({
      layout: broadcastFeedbackLayout(home),
      db,
      nowIso: "2026-08-25T10:00:00.000Z",
      historyDays: 30,
    })

    expect(examples.liked).toHaveLength(0)
    expect(examples.disliked).toHaveLength(0)
  })

  it("treats ambiguous reactions as disliked", () => {
    appendRecord(home, baseRecord(EVENT_DOWN, "ambiguous", "2026-08-20T10:00:00.000Z"))

    const examples = loadOperatorFeedbackExamples({
      layout: broadcastFeedbackLayout(home),
      db,
      nowIso: "2026-08-25T10:00:00.000Z",
    })

    expect(examples.disliked).toHaveLength(1)
    expect(examples.liked).toHaveLength(0)
  })
})

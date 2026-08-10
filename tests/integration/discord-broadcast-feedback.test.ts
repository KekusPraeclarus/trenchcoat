import { describe, expect, it, beforeEach } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openRouterDb } from "../../src/router/db.js"
import { indexDiscordProviderMessages } from "../../src/router/message-index.js"
import {
  applyBroadcastReaction,
  reconcileBroadcastFeedback,
  type ReactionSnapshot,
} from "../../src/discord/broadcast-feedback-listener.js"
import { broadcastFeedbackLayout } from "../../src/broadcast-feedback/paths.js"
import {
  currentFeedbackRecords,
  readPendingFollowups,
} from "../../src/broadcast-feedback/store.js"
import type { RouterEvent } from "../../src/contracts/schemas.js"

const OPERATOR = "200000000000000002"
const MESSAGE_ID = "100000000000000001"

const CONFIG = {
  enabled: true,
  channelId: "300000000000000003",
  followupTtlHours: 72,
  reconcileMaxMessages: 100,
} as const

function broadcastEvent(eventId: string): RouterEvent {
  return {
    schema: 1,
    eventId,
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
}

type Db = ReturnType<typeof openRouterDb>

function seed(args: Readonly<{
  db: Db
  eventId: string
  type?: string
  status?: string
  messageId?: string
}>): void {
  const event = broadcastEvent(args.eventId)
  const payload = { ...event, type: args.type ?? "finding.broadcast" }
  args.db.prepare(
    `INSERT OR IGNORE INTO destinations(id, kind, target, enabled) VALUES ('dest-1', 'discord', 'hook', 1)`,
  ).run()
  args.db.prepare(
    `INSERT INTO events(event_id, payload_hash, type, payload_json, occurred_at, run_id, accepted_at)
     VALUES (?, 'hash', ?, ?, ?, ?, 1)`,
  ).run(args.eventId, payload.type, JSON.stringify(payload), event.occurredAt, event.runId)
  args.db.prepare(
    `INSERT INTO deliveries(id, event_id, destination_id, status, attempt_count, updated_at)
     VALUES (?, ?, 'dest-1', ?, 1, 1)`,
  ).run(`del-${args.eventId.slice(0, 8)}`, args.eventId, args.status ?? "delivered")
  indexDiscordProviderMessages(args.db, {
    deliveryId: `del-${args.eventId.slice(0, 8)}`,
    eventId: args.eventId,
    destinationId: "dest-1",
    messageIds: [args.messageId ?? MESSAGE_ID],
    indexedAt: 1_000,
  })
}

let home: string
let db: Db

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tc-fb-int-"))
  db = openRouterDb(join(mkdtempSync(join(tmpdir(), "tc-fb-db-")), "router.sqlite3"))
})

async function react(args: Readonly<{
  up: boolean
  down: boolean
  messageId?: string
  nowIso?: string
}>) {
  return applyBroadcastReaction({
    db,
    messageId: args.messageId ?? MESSAGE_ID,
    operatorUserId: OPERATOR,
    reactions: { up: args.up, down: args.down },
    config: CONFIG,
    home,
    nowIso: args.nowIso ?? "2026-08-10T00:00:00.000Z",
  })
}

describe("discord broadcast feedback end to end", () => {
  it("records an up reaction on a delivered broadcast", async () => {
    seed({ db, eventId: `sha256:${"a".repeat(64)}` })
    const result = await react({ up: true, down: false })
    expect("outcome" in result && result.outcome).toBe("recorded")
    const records = currentFeedbackRecords(broadcastFeedbackLayout(home))
    expect(records[0]?.state).toBe("up")
  })

  it("asks for detail after a down reaction", async () => {
    seed({ db, eventId: `sha256:${"b".repeat(64)}` })
    const result = await react({ up: false, down: true })
    expect("needsFollowup" in result && result.needsFollowup).toBe(true)
    expect(readPendingFollowups(broadcastFeedbackLayout(home)).pending).toHaveLength(1)
  })

  it("skips an unknown message", async () => {
    const result = await react({ up: true, down: false, messageId: "999" })
    expect(result).toEqual({ skipped: "unknown-message" })
  })

  it("skips an event that is not a broadcast", async () => {
    seed({ db, eventId: `sha256:${"c".repeat(64)}`, type: "narrative.digest" })
    const result = await react({ up: true, down: false })
    expect(result).toEqual({ skipped: "not-a-broadcast" })
  })

  it("skips a delivery that never reached discord", async () => {
    seed({ db, eventId: `sha256:${"d".repeat(64)}`, status: "retry" })
    const result = await react({ up: true, down: false })
    expect(result).toEqual({ skipped: "not-delivered" })
  })

  it("reconciles reactions added while the listener was down", async () => {
    seed({ db, eventId: `sha256:${"e".repeat(64)}` })
    const reactions = new Map<string, ReactionSnapshot>([
      [MESSAGE_ID, { up: false, down: true }],
    ])
    const changed = await reconcileBroadcastFeedback({
      db,
      operatorUserId: OPERATOR,
      config: CONFIG,
      home,
      nowIso: "2026-08-10T00:00:00.000Z",
      readReactions: async (id) => reactions.get(id),
    })
    expect(changed).toBe(1)
    const records = currentFeedbackRecords(broadcastFeedbackLayout(home))
    expect(records[0]?.state).toBe("down")
  })

  it("changes nothing when reconcile finds no operator reaction", async () => {
    seed({ db, eventId: `sha256:${"f".repeat(64)}` })
    const changed = await reconcileBroadcastFeedback({
      db,
      operatorUserId: OPERATOR,
      config: CONFIG,
      home,
      readReactions: async () => ({ up: false, down: false }),
    })
    expect(changed).toBe(0)
    expect(currentFeedbackRecords(broadcastFeedbackLayout(home))).toHaveLength(0)
  })
})

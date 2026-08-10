import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openRouterDb } from "../../src/router/db.js"
import {
  backfillDiscordProviderMessages,
  indexDiscordProviderMessages,
  recentIndexedDiscordMessages,
  resolveDeliveryByDiscordMessageId,
} from "../../src/router/message-index.js"

function openTempDb(): ReturnType<typeof openRouterDb> {
  const dir = mkdtempSync(join(tmpdir(), "tc-msg-index-"))
  return openRouterDb(join(dir, "router.sqlite3"))
}

function seedDelivery(
  db: ReturnType<typeof openRouterDb>,
  args: Readonly<{
    deliveryId: string
    eventId: string
    destinationId: string
    kind: "discord" | "telegram"
    messageIds?: readonly string[]
    updatedAt: number
    status?: string
  }>,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO destinations(id, kind, target, enabled) VALUES (?, ?, ?, 1)`,
  ).run(args.destinationId, args.kind, "target")
  db.prepare(
    `INSERT OR IGNORE INTO events(event_id, payload_hash, type, payload_json, occurred_at, run_id, accepted_at)
     VALUES (?, 'hash', 'finding.broadcast', '{}', '2026-08-10T00:00:00.000Z', 'run-1', ?)`,
  ).run(args.eventId, args.updatedAt)
  db.prepare(
    `INSERT INTO deliveries(id, event_id, destination_id, status, attempt_count, updated_at, provider_message_ids)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    args.deliveryId,
    args.eventId,
    args.destinationId,
    args.status ?? "delivered",
    args.updatedAt,
    args.messageIds ? JSON.stringify(args.messageIds) : null,
  )
}

describe("provider message index", () => {
  it("maps every message part back to one delivery", () => {
    const db = openTempDb()
    const count = indexDiscordProviderMessages(db, {
      deliveryId: "del-1",
      eventId: "event-1",
      destinationId: "dest-1",
      messageIds: ["100000000000000001", "100000000000000002"],
      indexedAt: 1_000,
    })
    expect(count).toBe(2)

    const first = resolveDeliveryByDiscordMessageId(db, "100000000000000001")
    const second = resolveDeliveryByDiscordMessageId(db, "100000000000000002")
    expect(first?.eventId).toBe("event-1")
    expect(first?.partIndex).toBe(0)
    expect(second?.partIndex).toBe(1)
    expect(second?.partTotal).toBe(2)
  })

  it("stays idempotent across repeated indexing", () => {
    const db = openTempDb()
    const args = {
      deliveryId: "del-1",
      eventId: "event-1",
      destinationId: "dest-1",
      messageIds: ["100000000000000001"],
      indexedAt: 1_000,
    } as const
    indexDiscordProviderMessages(db, args)
    indexDiscordProviderMessages(db, args)
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM provider_message_index`)
      .get() as { n: number }
    expect(rows.n).toBe(1)
  })

  it("returns undefined for an unknown message", () => {
    const db = openTempDb()
    expect(resolveDeliveryByDiscordMessageId(db, "999")).toBeUndefined()
  })

  it("backfills delivered discord rows inside the history window", () => {
    const db = openTempDb()
    const now = Date.parse("2026-08-10T00:00:00.000Z")
    seedDelivery(db, {
      deliveryId: "del-fresh",
      eventId: "event-fresh",
      destinationId: "dest-discord",
      kind: "discord",
      messageIds: ["100000000000000010"],
      updatedAt: now - 86_400_000,
    })
    seedDelivery(db, {
      deliveryId: "del-old",
      eventId: "event-old",
      destinationId: "dest-discord",
      kind: "discord",
      messageIds: ["100000000000000011"],
      updatedAt: now - 40 * 86_400_000,
    })
    seedDelivery(db, {
      deliveryId: "del-telegram",
      eventId: "event-telegram",
      destinationId: "dest-telegram",
      kind: "telegram",
      messageIds: ["55"],
      updatedAt: now,
    })
    seedDelivery(db, {
      deliveryId: "del-retry",
      eventId: "event-retry",
      destinationId: "dest-discord",
      kind: "discord",
      messageIds: ["100000000000000012"],
      updatedAt: now,
      status: "retry",
    })

    const indexed = backfillDiscordProviderMessages(db, { nowMs: now, historyDays: 30 })
    expect(indexed).toBe(1)
    expect(resolveDeliveryByDiscordMessageId(db, "100000000000000010")).toBeDefined()
    expect(resolveDeliveryByDiscordMessageId(db, "100000000000000011")).toBeUndefined()
    expect(resolveDeliveryByDiscordMessageId(db, "55")).toBeUndefined()
    expect(resolveDeliveryByDiscordMessageId(db, "100000000000000012")).toBeUndefined()
  })

  it("lists the newest indexed messages first", () => {
    const db = openTempDb()
    indexDiscordProviderMessages(db, {
      deliveryId: "del-1",
      eventId: "event-1",
      destinationId: "dest-1",
      messageIds: ["100000000000000001"],
      indexedAt: 1_000,
    })
    indexDiscordProviderMessages(db, {
      deliveryId: "del-2",
      eventId: "event-2",
      destinationId: "dest-1",
      messageIds: ["100000000000000002"],
      indexedAt: 2_000,
    })
    const recent = recentIndexedDiscordMessages(db, 1)
    expect(recent).toHaveLength(1)
    expect(recent[0]?.eventId).toBe("event-2")
  })
})

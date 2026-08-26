import Database from "better-sqlite3"
import { existsSync } from "node:fs"
import { RouterEventSchema, type RouterEvent } from "../contracts/schemas.js"
import {
  backfillDiscordProviderMessages,
  recentIndexedDiscordMessages,
  resolveDeliveryByDiscordMessageId,
  type ProviderMessageIndexRow,
} from "../router/message-index.js"

/**
 * Read-only lookups from a Discord message id back to the router event that
 * produced it. Feedback never mutates router state; it only reads provenance.
 */

export type ResolvedBroadcast = Readonly<{
  index: ProviderMessageIndexRow
  event: RouterEvent
}>

export type ResolveReason =
  | "no-router-db"
  | "unknown-message"
  | "missing-event"
  | "unreadable-event"
  | "not-a-broadcast"
  | "not-delivered"

export type ResolveResult =
  | Readonly<{ ok: true; resolved: ResolvedBroadcast }>
  | Readonly<{ ok: false; reason: ResolveReason }>

export function openRouterDbReadOnly(path: string): Database.Database | undefined {
  if (!existsSync(path)) return undefined
  try {
    return new Database(path, { readonly: true })
  } catch {
    return undefined
  }
}

export function resolveBroadcastByMessageId(
  db: Database.Database,
  messageId: string,
): ResolveResult {
  const index = resolveDeliveryByDiscordMessageId(db, messageId)
  if (!index) return { ok: false, reason: "unknown-message" }

  const delivery = db.prepare(
    `SELECT status FROM deliveries WHERE id = ?`,
  ).get(index.deliveryId) as { status: string } | undefined
  if (delivery?.status !== "delivered") return { ok: false, reason: "not-delivered" }

  const row = db.prepare(
    `SELECT payload_json FROM events WHERE event_id = ?`,
  ).get(index.eventId) as { payload_json: string } | undefined
  if (!row) return { ok: false, reason: "missing-event" }

  let parsed: RouterEvent
  try {
    parsed = RouterEventSchema.parse(JSON.parse(row.payload_json)) as RouterEvent
  } catch {
    return { ok: false, reason: "unreadable-event" }
  }
  if (parsed.type !== "finding.broadcast") return { ok: false, reason: "not-a-broadcast" }
  return { ok: true, resolved: { index, event: parsed } }
}

/** Load a delivered broadcast event by stable event id (feedback ledger stores this). */
export function resolveBroadcastByEventId(
  db: Database.Database,
  eventId: string,
): ResolveResult {
  const row = db.prepare(
    `SELECT payload_json FROM events WHERE event_id = ?`,
  ).get(eventId) as { payload_json: string } | undefined
  if (!row) return { ok: false, reason: "missing-event" }

  let parsed: RouterEvent
  try {
    parsed = RouterEventSchema.parse(JSON.parse(row.payload_json)) as RouterEvent
  } catch {
    return { ok: false, reason: "unreadable-event" }
  }
  if (parsed.type !== "finding.broadcast") return { ok: false, reason: "not-a-broadcast" }

  const delivered = db.prepare(
    `SELECT id FROM deliveries WHERE event_id = ? AND status = 'delivered' LIMIT 1`,
  ).get(eventId) as { id: string } | undefined
  if (!delivered) return { ok: false, reason: "not-delivered" }

  const index = db.prepare(
    `SELECT message_id, destination_id, delivery_id, part_index, part_total, indexed_at
     FROM provider_message_index WHERE event_id = ? ORDER BY part_index ASC LIMIT 1`,
  ).get(eventId) as ProviderMessageIndexRow | undefined

  return {
    ok: true,
    resolved: {
      index: index ?? {
        messageId: "",
        destinationId: "",
        deliveryId: delivered.id,
        eventId,
        partIndex: 0,
        partTotal: 1,
        indexedAt: 0,
      },
      event: parsed,
    },
  }
}

export { backfillDiscordProviderMessages, recentIndexedDiscordMessages }

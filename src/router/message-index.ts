import type Database from "better-sqlite3"

/**
 * Map one Discord provider message id back to the delivery and event that
 * produced it. Operator reactions arrive with a message id only, so without
 * this index the host cannot prove which broadcast a reaction refers to.
 */

export const PROVIDER_MESSAGE_INDEX_SQL = `
CREATE TABLE IF NOT EXISTS provider_message_index (
  message_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  part_index INTEGER NOT NULL,
  part_total INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS provider_message_index_event
  ON provider_message_index(event_id);
`

export type ProviderMessageIndexRow = Readonly<{
  messageId: string
  deliveryId: string
  eventId: string
  destinationId: string
  partIndex: number
  partTotal: number
  indexedAt: number
}>

export function ensureProviderMessageIndex(db: Database.Database): void {
  db.exec(PROVIDER_MESSAGE_INDEX_SQL)
}

/** Idempotent: a repeated delivery row writes the same primary keys */
export function indexDiscordProviderMessages(
  db: Database.Database,
  args: Readonly<{
    deliveryId: string
    eventId: string
    destinationId: string
    messageIds: readonly string[]
    indexedAt: number
  }>,
): number {
  if (args.messageIds.length === 0) return 0
  ensureProviderMessageIndex(db)
  const insert = db.prepare(
    `INSERT INTO provider_message_index
       (message_id, delivery_id, event_id, destination_id, part_index, part_total, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       delivery_id = excluded.delivery_id,
       event_id = excluded.event_id,
       destination_id = excluded.destination_id,
       part_index = excluded.part_index,
       part_total = excluded.part_total`,
  )
  const total = args.messageIds.length
  const run = db.transaction(() => {
    for (const [index, messageId] of args.messageIds.entries()) {
      insert.run(
        messageId,
        args.deliveryId,
        args.eventId,
        args.destinationId,
        index,
        total,
        args.indexedAt,
      )
    }
  })
  run()
  return total
}

/** True when the table exists; read paths may run against a read-only handle */
function hasIndexTable(db: Database.Database): boolean {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_message_index'`,
  ).get() as { name: string } | undefined
  return row !== undefined
}

export function resolveDeliveryByDiscordMessageId(
  db: Database.Database,
  messageId: string,
): ProviderMessageIndexRow | undefined {
  if (!hasIndexTable(db)) return undefined
  const row = db.prepare(
    `SELECT message_id, delivery_id, event_id, destination_id, part_index, part_total, indexed_at
     FROM provider_message_index WHERE message_id = ?`,
  ).get(messageId) as Readonly<{
    message_id: string
    delivery_id: string
    event_id: string
    destination_id: string
    part_index: number
    part_total: number
    indexed_at: number
  }> | undefined
  if (!row) return undefined
  return {
    messageId: row.message_id,
    deliveryId: row.delivery_id,
    eventId: row.event_id,
    destinationId: row.destination_id,
    partIndex: row.part_index,
    partTotal: row.part_total,
    indexedAt: row.indexed_at,
  }
}

/**
 * Backfill the index from delivered Discord rows inside the history window.
 * Router startup calls this once, so reactions on older broadcasts still
 * resolve after an upgrade.
 */
export function backfillDiscordProviderMessages(
  db: Database.Database,
  args: Readonly<{ nowMs: number; historyDays: number }>,
): number {
  ensureProviderMessageIndex(db)
  const since = args.nowMs - args.historyDays * 86_400_000
  const rows = db.prepare(
    `SELECT d.id AS delivery_id, d.event_id, d.destination_id, d.provider_message_ids
     FROM deliveries d
     JOIN destinations dest ON dest.id = d.destination_id
     WHERE dest.kind = 'discord'
       AND d.status = 'delivered'
       AND d.provider_message_ids IS NOT NULL
       AND d.updated_at >= ?`,
  ).all(since) as Array<{
    delivery_id: string
    event_id: string
    destination_id: string
    provider_message_ids: string
  }>
  let indexed = 0
  for (const row of rows) {
    let messageIds: unknown
    try {
      messageIds = JSON.parse(row.provider_message_ids)
    } catch {
      continue
    }
    if (!Array.isArray(messageIds)) continue
    indexed += indexDiscordProviderMessages(db, {
      deliveryId: row.delivery_id,
      eventId: row.event_id,
      destinationId: row.destination_id,
      messageIds: messageIds.filter((id): id is string => typeof id === "string"),
      indexedAt: args.nowMs,
    })
  }
  return indexed
}

/** Latest indexed Discord messages, newest first — used by listener reconcile */
export function recentIndexedDiscordMessages(
  db: Database.Database,
  limit: number,
): readonly ProviderMessageIndexRow[] {
  if (!hasIndexTable(db)) return []
  const rows = db.prepare(
    `SELECT message_id, delivery_id, event_id, destination_id, part_index, part_total, indexed_at
     FROM provider_message_index
     ORDER BY indexed_at DESC, message_id DESC
     LIMIT ?`,
  ).all(limit) as Array<{
    message_id: string
    delivery_id: string
    event_id: string
    destination_id: string
    part_index: number
    part_total: number
    indexed_at: number
  }>
  return rows.map((row) => ({
    messageId: row.message_id,
    deliveryId: row.delivery_id,
    eventId: row.event_id,
    destinationId: row.destination_id,
    partIndex: row.part_index,
    partTotal: row.part_total,
    indexedAt: row.indexed_at,
  }))
}

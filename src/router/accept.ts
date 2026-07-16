import type Database from "better-sqlite3"
import { randomBytes } from "node:crypto"
import {
  canonicalizeRouterEvent,
  eventPayloadHash,
  verifyRouterHmac,
} from "../lib/router-contract.js"
import type { RouterEvent } from "../contracts/schemas.js"
import { purgeOldNonces } from "./db.js"

export type AcceptResult =
  | { status: "accepted"; eventId: string; deliveryIds: string[] }
  | { status: "duplicate"; eventId: string; deliveryIds: string[] }
  | { status: "conflict"; eventId: string }

export function ensureDefaultDestinations(
  db: Database.Database,
  opts: Readonly<{ telegramChatId?: string; discordWebhookUrl?: string }>,
): void {
  const upsert = db.prepare(
    `INSERT INTO destinations(id, kind, target, enabled) VALUES (?, ?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET target=excluded.target, enabled=1`,
  )
  if (opts.telegramChatId) {
    upsert.run("telegram:default", "telegram", opts.telegramChatId)
  }
  if (opts.discordWebhookUrl) {
    upsert.run("discord:default", "discord", opts.discordWebhookUrl)
  }
}

export function acceptEvent(
  db: Database.Database,
  rawBody: string,
  auth: Readonly<{
    hmacKey: string
    method: string
    path: string
    timestamp: string
    nonce: string
    signatureHex: string
    nowMs?: number
  }>,
): AcceptResult {
  const verified = verifyRouterHmac({
    hmacKey: auth.hmacKey,
    method: auth.method,
    path: auth.path,
    timestamp: auth.timestamp,
    nonce: auth.nonce,
    body: rawBody,
    signatureHex: auth.signatureHex,
    ...(auth.nowMs === undefined ? {} : { nowMs: auth.nowMs }),
  })
  if (!verified.ok) {
    db.prepare(
      `INSERT INTO incidents(created_at, kind, detail) VALUES (?, ?, ?)`,
    ).run(Date.now(), "auth-reject", verified.reason)
    throw new Error(`Unauthorized: ${verified.reason}`)
  }

  const now = auth.nowMs ?? Date.now()
  purgeOldNonces(db, now - 10 * 60 * 1000)
  const nonceInsert = db.prepare(
    `INSERT INTO nonces(nonce, seen_at) VALUES (?, ?)`,
  )
  try {
    nonceInsert.run(auth.nonce, now)
  } catch {
    db.prepare(
      `INSERT INTO incidents(created_at, kind, detail) VALUES (?, ?, ?)`,
    ).run(now, "nonce-replay", auth.nonce)
    throw new Error("Unauthorized: nonce-replay")
  }

  const event = canonicalizeRouterEvent(JSON.parse(rawBody) as unknown)
  const payloadHash = eventPayloadHash(event)
  const existing = db.prepare(
    `SELECT event_id, payload_hash FROM events WHERE event_id = ?`,
  ).get(event.eventId) as { event_id: string; payload_hash: string } | undefined

  if (existing) {
    if (existing.payload_hash === payloadHash) {
      const deliveries = db.prepare(
        `SELECT id FROM deliveries WHERE event_id = ?`,
      ).all(event.eventId) as Array<{ id: string }>
      return {
        status: "duplicate",
        eventId: event.eventId,
        deliveryIds: deliveries.map((d) => d.id),
      }
    }
    db.prepare(
      `INSERT INTO incidents(created_at, kind, detail) VALUES (?, ?, ?)`,
    ).run(now, "event-conflict", event.eventId)
    return { status: "conflict", eventId: event.eventId }
  }

  const insertEvent = db.prepare(
    `INSERT INTO events(event_id, payload_hash, type, payload_json, occurred_at, run_id, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const destinations = db.prepare(
    `SELECT id FROM destinations WHERE enabled = 1`,
  ).all() as Array<{ id: string }>
  const insertDelivery = db.prepare(
    `INSERT INTO deliveries(id, event_id, destination_id, status, attempt_count, updated_at)
     VALUES (?, ?, ?, 'pending', 0, ?)`,
  )

  const deliveryIds: string[] = []
  const tx = db.transaction((ev: RouterEvent) => {
    insertEvent.run(
      ev.eventId,
      payloadHash,
      ev.type,
      JSON.stringify(ev),
      ev.occurredAt,
      ev.runId,
      now,
    )
    for (const dest of destinations) {
      const id = `dlv_${randomBytes(8).toString("hex")}`
      insertDelivery.run(id, ev.eventId, dest.id, now)
      deliveryIds.push(id)
    }
  })
  tx(event)

  return { status: "accepted", eventId: event.eventId, deliveryIds }
}

import type Database from "better-sqlite3"
import type { FetchLike } from "../collectors/market/geckoterminal.js"
import { RouterEventSchema, type RouterEvent } from "../contracts/schemas.js"
import { splitTelegramText, telegramSendFormattedChunks } from "../lib/telegram-bot.js"

export type DestinationRow = Readonly<{
  id: string
  kind: "telegram" | "discord"
  target: string
}>

export type DeliveryRow = Readonly<{
  id: string
  event_id: string
  destination_id: string
  status: string
  attempt_count: number
}>

const MAX_ATTEMPTS = 8

/** Soft cap under Discord's 2000 hard limit; leaves room for part prefixes */
export const DISCORD_SAFE_CHUNK = 1_900

/**
 * Split text into Discord-safe chunks at paragraph boundaries.
 * Numbered `1/n` … when more than one part. Mirrors Telegram splitting.
 */
export function splitDiscordText(
  text: string,
  limit = DISCORD_SAFE_CHUNK,
): string[] {
  return splitTelegramText(text, limit)
}

/** Stable per-part key so Discord Idempotency-Key survives retries */
export function discordPartIdempotencyKey(
  deliveryId: string,
  partIndex: number,
  partTotal: number,
): string {
  if (!/^[A-Za-z0-9:_-]{1,128}$/u.test(deliveryId)) {
    throw new TypeError("unsafe delivery id for discord idempotency key")
  }
  if (!Number.isSafeInteger(partIndex) || partIndex < 0 || partIndex >= partTotal) {
    throw new TypeError("discord part index out of range")
  }
  if (!Number.isSafeInteger(partTotal) || partTotal < 1 || partTotal > 64) {
    throw new TypeError("discord part total out of range")
  }
  return `${deliveryId}:part:${partIndex + 1}/${partTotal}`
}

export async function deliverTelegram(
  fetcher: FetchLike,
  botToken: string,
  chatId: string,
  text: string,
): Promise<{ messageIds: string[] }> {
  const result = await telegramSendFormattedChunks(fetcher, botToken, chatId, text)
  return { messageIds: result.messageIds }
}

export async function deliverDiscord(
  fetcher: FetchLike,
  webhookUrl: string,
  text: string,
  opts?: Readonly<{
    idempotencyKeyBase?: string
    replyToMessageId?: string
  }>,
): Promise<{ messageIds: string[] }> {
  const url = new URL(webhookUrl)
  url.searchParams.set("wait", "true")
  const parts = splitDiscordText(text)
  const keyBase = opts?.idempotencyKeyBase
  const messageIds: string[] = []
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    }
    if (keyBase) {
      headers["Idempotency-Key"] = discordPartIdempotencyKey(keyBase, i, parts.length)
    }
    const body: Record<string, unknown> = {
      content: part,
      allowed_mentions: { parse: [] },
    }
    if (i === 0 && opts?.replyToMessageId) {
      body["message_reference"] = {
        message_id: opts.replyToMessageId,
        fail_if_not_exists: false,
      }
    }
    const response = await fetcher(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500
      const err = new Error(`discord HTTP ${response.status}`) as Error & {
        retryable?: boolean
        retryAfterSeconds?: number
      }
      err.retryable = retryable
      const ra = response.headers.get("retry-after")
      if (ra) err.retryAfterSeconds = Number(ra)
      throw err
    }
    try {
      const payload = await response.json() as { id?: string }
      if (typeof payload.id === "string") messageIds.push(payload.id)
    } catch {
      // wait=true should return JSON; ignore parse miss
    }
  }
  return { messageIds }
}

export function leaseNextDelivery(
  db: Database.Database,
  owner: string,
  nowMs: number,
  leaseMs = 30_000,
): DeliveryRow | undefined {
  const row = db.prepare(
    `SELECT d.id, d.event_id, d.destination_id, d.status, d.attempt_count
     FROM deliveries d
     WHERE d.status IN ('pending', 'retry')
       AND (d.lease_until IS NULL OR d.lease_until < ?)
     ORDER BY d.updated_at ASC
     LIMIT 1`,
  ).get(nowMs) as DeliveryRow | undefined
  if (!row) return undefined
  db.prepare(
    `UPDATE deliveries SET lease_owner = ?, lease_until = ?, status = 'in-flight', updated_at = ?
     WHERE id = ?`,
  ).run(owner, nowMs + leaseMs, nowMs, row.id)
  return row
}

export async function processDelivery(
  db: Database.Database,
  fetcher: FetchLike,
  delivery: DeliveryRow,
  opts: Readonly<{ telegramBotToken?: string }>,
): Promise<void> {
  const dest = db.prepare(
    `SELECT id, kind, target FROM destinations WHERE id = ?`,
  ).get(delivery.destination_id) as DestinationRow | undefined
  const eventRow = db.prepare(
    `SELECT payload_json FROM events WHERE event_id = ?`,
  ).get(delivery.event_id) as { payload_json: string } | undefined
  if (!dest || !eventRow) {
    db.prepare(
      `UPDATE deliveries SET status = 'dead', last_error = ?, updated_at = ? WHERE id = ?`,
    ).run("missing dest/event", Date.now(), delivery.id)
    return
  }

  const event = RouterEventSchema.parse(JSON.parse(eventRow.payload_json)) as RouterEvent
  const now = Date.now()

  // When channels were host-rendered, omit destinations without a payload
  // (topic-merged followers; correction destination scoping).
  // Lifecycle events have no channels → both fire.
  if (event.channels) {
    if (dest.kind === "discord" && event.channels.discord === undefined) {
      db.prepare(
        `UPDATE deliveries SET status = 'delivered', lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`,
      ).run(now, delivery.id)
      db.prepare(
        `INSERT INTO attempts(delivery_id, attempted_at, ok, detail) VALUES (?, ?, 1, 'skipped-no-channel-payload')`,
      ).run(delivery.id, now)
      return
    }
    if (dest.kind === "telegram" && event.channels.telegram === undefined) {
      db.prepare(
        `UPDATE deliveries SET status = 'delivered', lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`,
      ).run(now, delivery.id)
      db.prepare(
        `INSERT INTO attempts(delivery_id, attempted_at, ok, detail) VALUES (?, ?, 1, 'skipped-no-channel-payload')`,
      ).run(delivery.id, now)
      return
    }
  }

  const channelText = dest.kind === "telegram"
    ? event.channels?.telegram?.text
    : dest.kind === "discord"
      ? event.channels?.discord?.text
      : undefined
  const text = channelText ?? event.text
  try {
    let messageIds: string[] = []
    if (dest.kind === "telegram") {
      if (!opts.telegramBotToken) throw Object.assign(new Error("no telegram token"), { retryable: false })
      const result = await deliverTelegram(fetcher, opts.telegramBotToken, dest.target, text)
      messageIds = result.messageIds
    } else if (dest.kind === "discord") {
      const replyTo = event.type === "finding.correction"
        && event.correction?.replyToProviderMessageId
        ? event.correction.replyToProviderMessageId
        : undefined
      const result = await deliverDiscord(fetcher, dest.target, text, {
        idempotencyKeyBase: delivery.id,
        ...(replyTo ? { replyToMessageId: replyTo } : {}),
      })
      messageIds = result.messageIds
    } else {
      throw Object.assign(new Error(`unknown dest kind`), { retryable: false })
    }
    db.prepare(
      `UPDATE deliveries SET status = 'delivered', lease_owner = NULL, lease_until = NULL,
       provider_message_ids = ?, updated_at = ? WHERE id = ?`,
    ).run(messageIds.length > 0 ? JSON.stringify(messageIds) : null, now, delivery.id)
    db.prepare(
      `INSERT INTO attempts(delivery_id, attempted_at, ok, detail) VALUES (?, ?, 1, ?)`,
    ).run(
      delivery.id,
      now,
      messageIds.length > 0 ? `ok:${messageIds[0]}` : "ok",
    )
  } catch (error) {
    const err = error as Error & { retryable?: boolean; retryAfterSeconds?: number }
    const attempts = delivery.attempt_count + 1
    const ambiguous = err.message.includes("abort") || err.message.includes("Timeout")
    const retryable = err.retryable !== false && attempts < MAX_ATTEMPTS
    const status = retryable ? "retry" : "dead"
    db.prepare(
      `UPDATE deliveries
       SET status = ?, attempt_count = ?, duplicate_risk = CASE WHEN ? THEN 1 ELSE duplicate_risk END,
           last_error = ?, lease_owner = NULL, lease_until = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      status,
      attempts,
      ambiguous ? 1 : 0,
      err.message.slice(0, 500),
      err.retryAfterSeconds ? now + err.retryAfterSeconds * 1000 : null,
      now,
      delivery.id,
    )
    db.prepare(
      `INSERT INTO attempts(delivery_id, attempted_at, ok, detail) VALUES (?, ?, 0, ?)`,
    ).run(delivery.id, now, err.message.slice(0, 500))
  }
}

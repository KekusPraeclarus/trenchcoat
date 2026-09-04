import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import type Database from "better-sqlite3"
import { openRouterDb } from "./db.js"
import { acceptEvent, ensureDefaultDestinations } from "./accept.js"
import { leaseNextDelivery, processDelivery } from "./deliver.js"
import { resolveGrokIntakeConfig } from "./grok-deliver.js"
import type { FetchLike } from "../collectors/market/geckoterminal.js"
import { log } from "../lib/log.js"
import { backfillDiscordProviderMessages } from "./message-index.js"

/** Reaction history window for the Discord provider message index (ADR 043) */
const PROVIDER_MESSAGE_HISTORY_DAYS = 30

export type RouterServerOptions = Readonly<{
  dbPath: string
  hmacKey: string
  host?: string
  port?: number
  telegramBotToken?: string
  telegramChatId?: string
  discordWebhookUrl?: string
  grokWebhookUrl?: string
  grokSenderKey?: string
  fetcher?: FetchLike
  workerIntervalMs?: number
}>

export type RouterServer = Readonly<{
  app: FastifyInstance
  db: Database.Database
  start: () => Promise<string>
  stop: () => Promise<void>
}>

export function createRouterServer(opts: RouterServerOptions): RouterServer {
  const db = openRouterDb(opts.dbPath)
  // Reactions can arrive on broadcasts delivered before this index existed
  try {
    const indexed = backfillDiscordProviderMessages(db, {
      nowMs: Date.now(),
      historyDays: PROVIDER_MESSAGE_HISTORY_DAYS,
    })
    if (indexed > 0) log.info("router indexed discord messages", { count: indexed })
  } catch (error) {
    log.warn("router message index backfill failed", {
      detail: error instanceof Error ? error.message : "unknown",
    })
  }
  const grok = resolveGrokIntakeConfig({
    ...(opts.grokWebhookUrl ? { webhookUrl: opts.grokWebhookUrl } : {}),
    ...(opts.grokSenderKey ? { senderKey: opts.grokSenderKey } : {}),
  })
  if ((opts.grokWebhookUrl || opts.grokSenderKey) && !grok) {
    log.warn("router grok intake skipped", { reason: "incomplete-or-invalid-env" })
  }
  ensureDefaultDestinations(db, {
    ...(opts.telegramChatId ? { telegramChatId: opts.telegramChatId } : {}),
    ...(opts.discordWebhookUrl ? { discordWebhookUrl: opts.discordWebhookUrl } : {}),
    ...(grok ? { grokWebhookUrl: grok.webhookUrl } : {}),
  })

  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    trustProxy: false,
  })

  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, body)
    },
  )

  app.get("/healthz", async () => ({ ok: true }))

  app.post("/v1/events", async (req, reply) => {
    const rawBody = typeof req.body === "string" ? req.body : ""
    const timestamp = String(req.headers["x-tc-timestamp"] ?? "")
    const nonce = String(req.headers["x-tc-nonce"] ?? "")
    const signature = String(req.headers["x-tc-signature"] ?? "")
    try {
      const result = acceptEvent(db, rawBody, {
        hmacKey: opts.hmacKey,
        method: "POST",
        path: "/v1/events",
        timestamp,
        nonce,
        signatureHex: signature,
      })
      if (result.status === "conflict") {
        return reply.code(409).send({
          status: "conflict",
          event_id: result.eventId,
        })
      }
      if (result.status === "duplicate") {
        return reply.code(200).send({
          status: "duplicate",
          delivery_id: result.deliveryIds[0] ?? "none",
          event_id: result.eventId,
        })
      }
      return reply.code(202).send({
        status: "accepted",
        delivery_id: result.deliveryIds[0] ?? "none",
        event_id: result.eventId,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "error"
      if (message.startsWith("Unauthorized")) {
        return reply.code(401).send({ error: message })
      }
      log.error("router accept failed", { detail: message })
      return reply.code(400).send({ error: "bad-request" })
    }
  })

  const fetcher = opts.fetcher ?? fetch
  const owner = `worker-${process.pid}`
  let timer: NodeJS.Timeout | undefined
  let stopping = false

  async function tick(): Promise<void> {
    if (stopping) return
    const delivery = leaseNextDelivery(db, owner, Date.now())
    if (!delivery) return
    await processDelivery(db, fetcher, delivery, {
      ...(opts.telegramBotToken ? { telegramBotToken: opts.telegramBotToken } : {}),
      ...(opts.telegramChatId ? { telegramChatId: opts.telegramChatId } : {}),
      ...(grok ? { grokSenderKey: grok.senderKey } : {}),
    })
  }

  return {
    app,
    db,
    start: async () => {
      const host = opts.host ?? "127.0.0.1"
      const port = opts.port ?? 8787
      const addr = await app.listen({ host, port })
      timer = setInterval(() => {
        void tick()
      }, opts.workerIntervalMs ?? 500)
      return addr
    },
    stop: async () => {
      stopping = true
      if (timer) clearInterval(timer)
      await app.close()
      db.close()
    },
  }
}

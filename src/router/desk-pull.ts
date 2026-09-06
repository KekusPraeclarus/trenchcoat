import { createHash, timingSafeEqual } from "node:crypto"
import Fastify from "fastify"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import { isDeskTicketId, readDeskPending } from "./desk-queue.js"

export const DESK_PULL_TOKEN_MIN = 24
export const DESK_PULL_RATE_WINDOW_MS = 60_000
export const DESK_PULL_RATE_MAX = 20
export const DESK_PULL_DEFAULT_LIMIT = 50

const AckBodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(50),
}).strict()

export function deskPullTokenOk(header: string | undefined, token: string): boolean {
  const got = header?.startsWith("Bearer ") ? header.slice(7) : ""
  const a = createHash("sha256").update(got).digest()
  const b = createHash("sha256").update(token).digest()
  return timingSafeEqual(a, b)
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost"
}

export function assertDeskPullBind(host: string, tls: boolean): void {
  if (isLoopbackHost(host)) return
  if (!tls) {
    throw new Error("desk pull off-loopback requires TLS")
  }
}

export function assertDeskPullToken(token: string): string {
  const trimmed = token.trim()
  if (trimmed.length < DESK_PULL_TOKEN_MIN) {
    throw new Error("DESK_PULL_TOKEN is too short")
  }
  return trimmed
}

function clientIp(req: FastifyRequest): string {
  return req.ip || "unknown"
}

export function createDeskPullApp(opts: Readonly<{
  token: string
  logPath: string
  now?: () => Date
}>): FastifyInstance {
  const token = assertDeskPullToken(opts.token)
  const hits = new Map<string, number[]>()
  const app = Fastify({
    logger: false,
    bodyLimit: 8 * 1024,
    trustProxy: false,
  })

  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, body)
    },
  )

  function allow(ip: string, nowMs: number): boolean {
    const prev = (hits.get(ip) ?? []).filter((t) => nowMs - t < DESK_PULL_RATE_WINDOW_MS)
    if (prev.length >= DESK_PULL_RATE_MAX) {
      hits.set(ip, prev)
      return false
    }
    prev.push(nowMs)
    hits.set(ip, prev)
    return true
  }

  function gate(req: FastifyRequest) {
    const clock = opts.now ?? (() => new Date())
    const nowMs = clock().getTime()
    if (!allow(clientIp(req), nowMs)) {
      return { status: 429 as const, body: { error: "rate-limited" } }
    }
    if (!deskPullTokenOk(req.headers.authorization, token)) {
      return { status: 401 as const, body: { error: "unauthorized" } }
    }
    return undefined
  }

  app.get("/healthz", async () => ({ ok: true }))

  app.get("/desk/intake/pending", async (req, reply) => {
    const blocked = gate(req)
    if (blocked) return reply.code(blocked.status).send(blocked.body)
    const query = req.query as { since_id?: string; limit?: string }
    const sinceId = query.since_id?.trim() || undefined
    if (sinceId && !isDeskTicketId(sinceId)) {
      return reply.code(400).send({ error: "bad-since-id" })
    }
    const limitRaw = Number(query.limit ?? DESK_PULL_DEFAULT_LIMIT)
    const limit = Number.isFinite(limitRaw) ? limitRaw : DESK_PULL_DEFAULT_LIMIT
    const tickets = readDeskPending(opts.logPath, sinceId, limit)
    const now = opts.now ?? (() => new Date())
    return {
      tickets,
      server_time: now().toISOString(),
    }
  })

  app.post("/desk/intake/ack", async (req, reply) => {
    const blocked = gate(req)
    if (blocked) return reply.code(blocked.status).send(blocked.body)
    const raw = typeof req.body === "string" ? req.body : ""
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      return reply.code(400).send({ error: "bad-request" })
    }
    const body = AckBodySchema.safeParse(parsed)
    if (!body.success) return reply.code(400).send({ error: "bad-request" })
    return { ok: true, acked: body.data.ids.length }
  })

  return app
}

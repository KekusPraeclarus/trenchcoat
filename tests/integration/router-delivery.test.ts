import { describe, expect, it, afterEach } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRouterServer } from "../../src/router/server.js"
import {
  deliverRouterEvent,
  deliverBroadcast,
  buildBroadcastRouterEvent,
  resolveRouterIntakeUrl,
  validateRouterUrl,
  RouterDeliveryError,
} from "../../src/orchestrator/router.js"
import { signRouterRequest } from "../../src/lib/router-contract.js"
import type { RouterEvent } from "../../src/contracts/schemas.js"

const servers: Array<{ stop: () => Promise<void> }> = []
const hmacKey = "test-hmac-key-for-delivery"

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()
    if (s) await s.stop()
  }
})

async function startServer(): Promise<{ addr: string, port: number }> {
  const dir = mkdtempSync(join(tmpdir(), "tc-deliver-"))
  const server = createRouterServer({
    dbPath: join(dir, "router.sqlite3"),
    hmacKey,
    host: "127.0.0.1",
    port: 0,
    telegramChatId: "1",
    workerIntervalMs: 60_000,
    fetcher: async () => new Response("{}", { status: 200 }),
  })
  servers.push(server)
  const addr = await server.start()
  return { addr, port: Number(new URL(addr).port) }
}

const item = {
  severity: "watch" as const,
  text: "delivery contract check",
  refs: ["state/watchlist.json"],
  auditClaim: {
    type: "token-upside" as const,
    subject: "solana:token",
    direction: "up" as const,
    horizonHours: 72,
    verificationRule: "token.up.72h",
  },
}

describe("prop_inv_b5_hmac_orchestrator_delivery", () => {
  it("accepts then duplicates via HMAC deliverRouterEvent", async () => {
    const { port } = await startServer()
    const url = `http://127.0.0.1:${port}/v1/events`
    const event = buildBroadcastRouterEvent(
      "run-deliver-1",
      "2026-07-16T18:00:00.000Z",
      item,
    )
    const first = await deliverRouterEvent(fetch, url, hmacKey, event, 5_000, true)
    expect(first.status).toBe("accepted")
    const second = await deliverRouterEvent(fetch, url, hmacKey, event, 5_000, true)
    expect(second.status).toBe("duplicate")
  })

  it("bare loopback host defaults intake path to /v1/events", async () => {
    const { port } = await startServer()
    const event = buildBroadcastRouterEvent(
      "run-deliver-bare-host",
      "2026-07-16T18:00:00.000Z",
      item,
    )
    expect(resolveRouterIntakeUrl(`http://127.0.0.1:${port}/`).pathname).toBe("/v1/events")
    expect(() => validateRouterUrl("http://127.0.0.1:8787")).not.toThrow()
    expect(() => validateRouterUrl("http://example.com/v1/events")).toThrow(/HTTPS/)
    const result = await deliverRouterEvent(
      fetch,
      `http://127.0.0.1:${port}/`,
      hmacKey,
      event,
      5_000,
    )
    expect(result.status).toBe("accepted")
  })

  it("deliverBroadcast posts finding.broadcast without Bearer auth", async () => {
    const { port } = await startServer()
    const url = `http://127.0.0.1:${port}/v1/events`
    let sawAuth = false
    const fetcher: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      if (headers.get("authorization")) sawAuth = true
      return fetch(input, init)
    }
    const result = await deliverBroadcast(
      fetcher,
      url,
      hmacKey,
      "run-deliver-2",
      "2026-07-16T18:00:00.000Z",
      item,
      5_000,
      true,
    )
    expect(result.status).toBe("accepted")
    expect(sawAuth).toBe(false)
  })

  it("rejects bad signatures with 401", async () => {
    const { port } = await startServer()
    const event = buildBroadcastRouterEvent(
      "run-deliver-3",
      "2026-07-16T18:00:00.000Z",
      item,
    )
    await expect(deliverRouterEvent(
      fetch,
      `http://127.0.0.1:${port}/v1/events`,
      "wrong-hmac-key-value",
      event,
      5_000,
      true,
    )).rejects.toThrow(/HMAC rejected|401/i)
  })

  it("rejects nonce replay with 401", async () => {
    const { port } = await startServer()
    const event = buildBroadcastRouterEvent(
      "run-deliver-4",
      "2026-07-16T18:00:00.000Z",
      item,
    )
    const body = JSON.stringify(event)
    const ts = new Date().toISOString()
    const nonce = "nonce-replay-aaaaaaaa"
    const sig = signRouterRequest(hmacKey, "POST", "/v1/events", ts, nonce, body)
    const headers = {
      "content-type": "application/json",
      "x-tc-timestamp": ts,
      "x-tc-nonce": nonce,
      "x-tc-signature": sig,
    }
    const res1 = await fetch(`http://127.0.0.1:${port}/v1/events`, {
      method: "POST",
      headers,
      body,
    })
    expect(res1.status).toBe(202)
    const res2 = await fetch(`http://127.0.0.1:${port}/v1/events`, {
      method: "POST",
      headers,
      body,
    })
    expect(res2.status).toBe(401)
  })

  it("classifies conflict as non-retryable", async () => {
    const { port } = await startServer()
    const url = `http://127.0.0.1:${port}/v1/events`
    const event = buildBroadcastRouterEvent(
      "run-deliver-5",
      "2026-07-16T18:00:00.000Z",
      item,
    )
    await deliverRouterEvent(fetch, url, hmacKey, event, 5_000, true)
    const conflict: RouterEvent = { ...event, text: "mutated text for conflict" }
    await expect(deliverRouterEvent(
      fetch,
      url,
      hmacKey,
      conflict,
      5_000,
      true,
    )).rejects.toBeInstanceOf(RouterDeliveryError)
    try {
      await deliverRouterEvent(fetch, url, hmacKey, conflict, 5_000, true)
    } catch (error) {
      expect(error).toBeInstanceOf(RouterDeliveryError)
      expect((error as RouterDeliveryError).retryable).toBe(false)
    }
  })

  it("indexes discord provider message ids after delivery", async () => {
    const { openRouterDb } = await import("../../src/router/db.js")
    const { processDelivery } = await import("../../src/router/deliver.js")
    const { resolveDeliveryByDiscordMessageId } = await import(
      "../../src/router/message-index.js"
    )
    const dir = mkdtempSync(join(tmpdir(), "tc-index-"))
    const db = openRouterDb(join(dir, "router.sqlite3"))
    const event = buildBroadcastRouterEvent(
      "run-index-1",
      "2026-07-16T18:00:00.000Z",
      item,
    )
    db.prepare(
      `INSERT INTO destinations(id, kind, target, enabled)
       VALUES ('dest-discord', 'discord', 'https://discord.test/api/webhooks/1/token', 1)`,
    ).run()
    db.prepare(
      `INSERT INTO events(event_id, payload_hash, type, payload_json, occurred_at, run_id, accepted_at)
       VALUES (?, 'hash', ?, ?, ?, ?, 1)`,
    ).run(event.eventId, event.type, JSON.stringify(event), event.occurredAt, event.runId)
    db.prepare(
      `INSERT INTO deliveries(id, event_id, destination_id, status, attempt_count, updated_at)
       VALUES ('del-index-1', ?, 'dest-discord', 'pending', 0, 1)`,
    ).run(event.eventId)

    const fetcher = async () => new Response(
      JSON.stringify({ id: "100000000000000042" }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
    await processDelivery(
      db,
      fetcher as unknown as typeof fetch,
      {
        id: "del-index-1",
        event_id: event.eventId,
        destination_id: "dest-discord",
        status: "pending",
        attempt_count: 0,
      },
      {},
    )

    const indexed = resolveDeliveryByDiscordMessageId(db, "100000000000000042")
    expect(indexed?.eventId).toBe(event.eventId)
    expect(indexed?.deliveryId).toBe("del-index-1")
    expect(indexed?.partTotal).toBe(1)
  })

  it("rejects off-host HTTP and accepts literal loopback HTTP", () => {
    expect(() => validateRouterUrl("http://127.0.0.1:8787/v1/events")).not.toThrow()
    expect(() => validateRouterUrl("http://localhost:8787/v1/events")).not.toThrow()
    expect(() => validateRouterUrl("http://example.com/v1/events")).toThrow(/HTTPS/)
    expect(() => validateRouterUrl("https://router.example/v1/events")).not.toThrow()
  })

  it("retries failed ingress via retryPendingDeliveries without duplicating", async () => {
    const { port } = await startServer()
    const dir = mkdtempSync(join(tmpdir(), "tc-retry-"))
    const { ensureArchive } = await import("../../src/lib/archive.js")
    const { Outbox } = await import("../../src/lib/outbox.js")
    const { deliverStagedOutbox, retryPendingDeliveries, summarizeIngressCounts } =
      await import("../../src/orchestrator/delivery.js")
    const layout = await ensureArchive(join(dir, "archive"))
    const runId = "20260716T180000Z-retry01"
    const event = {
      ...buildBroadcastRouterEvent(runId, "2026-07-16T18:00:00.000Z", item),
      channels: {
        telegram: { text: item.text },
      },
    }
    await new Outbox(join(layout.routerOutbox, runId)).stage(event)

    let calls = 0
    const flaky: typeof fetch = async (input, init) => {
      calls += 1
      if (calls === 1) return new Response("", { status: 503 })
      return fetch(input, init)
    }
    const first = await deliverStagedOutbox({
      layout,
      runId,
      routerUrl: `http://127.0.0.1:${port}/v1/events`,
      hmacKey,
      nowIso: "2026-07-16T18:00:00.000Z",
      fetcher: flaky,
      backoffMs: 0,
    })
    expect(first[0]?.status).toBe("failed")
    expect(summarizeIngressCounts(layout, "2026-07-16T18:01:00.000Z").ingressPending).toBe(1)

    const retry = await retryPendingDeliveries({
      layout,
      routerUrl: `http://127.0.0.1:${port}/v1/events`,
      hmacKey,
      nowIso: "2026-07-16T18:02:00.000Z",
      fetcher: fetch,
      backoffMs: 0,
    })
    expect(retry.accepted).toBe(1)
    expect(retry.attempted).toBe(1)
    const again = await retryPendingDeliveries({
      layout,
      routerUrl: `http://127.0.0.1:${port}/v1/events`,
      hmacKey,
      nowIso: "2026-07-16T18:03:00.000Z",
      fetcher: fetch,
      backoffMs: 0,
    })
    expect(again.attempted).toBe(0)
    expect(again.pendingBefore).toBe(0)
    expect(summarizeIngressCounts(layout).accepted).toBe(1)
  })

  it("fans out per-channel text when channels are present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-channels-"))
    const seen: Array<{ kind: string; text: string; parseMode?: string }> = []
    const server = createRouterServer({
      dbPath: join(dir, "router.sqlite3"),
      hmacKey,
      host: "127.0.0.1",
      port: 0,
      telegramBotToken: "tg-token",
      telegramChatId: "42",
      discordWebhookUrl: "https://discord.example/webhook",
      workerIntervalMs: 50,
      fetcher: async (input, init) => {
        const url = String(input)
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          text?: string
          content?: string
          parse_mode?: string
        }
        if (url.includes("api.telegram.org")) {
          seen.push({
            kind: "telegram",
            text: body.text ?? "",
            ...(body.parse_mode !== undefined ? { parseMode: body.parse_mode } : {}),
          })
        } else if (url.includes("discord.example")) {
          seen.push({ kind: "discord", text: body.content ?? "" })
        }
        return new Response("{}", { status: 200 })
      },
    })
    servers.push(server)
    const addr = await server.start()
    const base = buildBroadcastRouterEvent(
      "run-deliver-channels",
      "2026-07-16T18:00:00.000Z",
      item,
    )
    const event: RouterEvent = {
      ...base,
      channels: {
        telegram: { text: "**FULL TELEGRAM REPORT**" },
        discord: { text: "SHORT DISCORD LINE" },
      },
    }
    await deliverRouterEvent(fetch, `${addr}/v1/events`, hmacKey, event, 5_000, true)
    const deadline = Date.now() + 3_000
    while (seen.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(seen).toEqual(expect.arrayContaining([
      { kind: "telegram", text: "<b>FULL TELEGRAM REPORT</b>", parseMode: "HTML" },
      { kind: "discord", text: "SHORT DISCORD LINE" },
    ]))
  })

  it("fans out a grok intake twin and isolates webhook failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-grok-fanout-"))
    const seen: Array<{ kind: string; status?: number; id?: string; auth?: string }> = []
    const server = createRouterServer({
      dbPath: join(dir, "router.sqlite3"),
      hmacKey,
      host: "127.0.0.1",
      port: 0,
      telegramBotToken: "tg-token",
      telegramChatId: "42",
      grokWebhookUrl: "https://grok.test/intake",
      grokSenderKey: "intake-key",
      workerIntervalMs: 50,
      fetcher: async (input, init) => {
        const url = String(input)
        if (url.includes("api.telegram.org")) {
          seen.push({ kind: "telegram", status: 200 })
          return new Response("{}", { status: 200 })
        }
        if (url.includes("grok.test")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { id?: string; text?: string }
          const auth = new Headers(init?.headers).get("authorization") ?? ""
          seen.push({
            kind: "grok",
            status: 503,
            ...(body.id ? { id: body.id } : {}),
            auth,
          })
          expect(body.text).toBe("FULL TELEGRAM REPORT")
          expect(auth).toBe("Bearer intake-key")
          return new Response("busy", { status: 503 })
        }
        return new Response("{}", { status: 200 })
      },
    })
    servers.push(server)
    const addr = await server.start()
    const base = buildBroadcastRouterEvent(
      "run-deliver-grok",
      "2026-07-16T18:00:00.000Z",
      item,
    )
    const event: RouterEvent = {
      ...base,
      channels: {
        telegram: { text: "FULL TELEGRAM REPORT" },
        grok: {
          id: "55555555-5555-4555-8555-555555555555",
          ts: "2026-07-16T18:00:00.000Z",
          source: "narrative-agent",
          channel: "telegram",
          text: "FULL TELEGRAM REPORT",
          urgency: "low",
          trade_intent: "watch",
        },
      },
    }
    await deliverRouterEvent(fetch, `${addr}/v1/events`, hmacKey, event, 5_000, true)
    const deadline = Date.now() + 4_000
    while (
      (!seen.some((row) => row.kind === "telegram") || !seen.some((row) => row.kind === "grok"))
      && Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(seen.some((row) => row.kind === "telegram")).toBe(true)
    const grok = seen.find((row) => row.kind === "grok")
    expect(grok?.id).toBe("55555555-5555-4555-8555-555555555555")
    expect(grok?.auth).toBe("Bearer intake-key")
    const dests = server.db.prepare(`SELECT kind, status FROM deliveries JOIN destinations ON destinations.id = deliveries.destination_id`).all() as Array<{
      kind: string
      status: string
    }>
    expect(dests.some((row) => row.kind === "telegram" && row.status === "delivered")).toBe(true)
    expect(dests.some((row) => row.kind === "grok" && (row.status === "retry" || row.status === "dead"))).toBe(true)
  })

  it("does not register grok when only one intake env var is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-grok-partial-"))
    const server = createRouterServer({
      dbPath: join(dir, "router.sqlite3"),
      hmacKey,
      host: "127.0.0.1",
      port: 0,
      grokWebhookUrl: "https://grok.test/intake",
      workerIntervalMs: 60_000,
      fetcher: async () => new Response("{}", { status: 200 }),
    })
    servers.push(server)
    await server.start()
    const rows = server.db.prepare(`SELECT kind FROM destinations`).all() as Array<{ kind: string }>
    expect(rows.some((row) => row.kind === "grok")).toBe(false)
  })
})

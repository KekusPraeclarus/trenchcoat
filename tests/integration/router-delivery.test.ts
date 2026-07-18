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

  it("fans out per-channel text when channels are present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-channels-"))
    const seen: Array<{ kind: string; text: string }> = []
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
        const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string; content?: string }
        if (url.includes("api.telegram.org")) {
          seen.push({ kind: "telegram", text: body.text ?? "" })
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
        telegram: { text: "FULL TELEGRAM REPORT" },
        discord: { text: "SHORT DISCORD LINE" },
      },
    }
    await deliverRouterEvent(fetch, `${addr}/v1/events`, hmacKey, event, 5_000, true)
    const deadline = Date.now() + 3_000
    while (seen.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(seen).toEqual(expect.arrayContaining([
      { kind: "telegram", text: "FULL TELEGRAM REPORT" },
      { kind: "discord", text: "SHORT DISCORD LINE" },
    ]))
  })
})

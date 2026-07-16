import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { eventPayloadHash, signRouterRequest } from "../../src/lib/router-contract.js"
import { createRouterServer, type RouterServer } from "../../src/router/server.js"

const hmacKey = "a-secure-test-hmac-key"
const servers: RouterServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
})

function event() {
  const base = {
    schema: 1 as const,
    occurredAt: "2026-01-01T00:00:00.000Z",
    runId: "run-1",
    type: "finding.broadcast" as const,
    severity: "watch" as const,
    text: "A valid broadcast",
    refs: ["state/decisions.md"],
    auditClaim: {
      type: "token-upside" as const,
      subject: "TEST",
      direction: "up" as const,
      horizonHours: 24,
      verificationRule: "test-rule",
    },
  }
  return { ...base, eventId: eventPayloadHash(base as never) }
}

async function post(addr: string, body: string, nonce: string): Promise<Response> {
  const timestamp = new Date().toISOString()
  return fetch(`${addr}/v1/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tc-timestamp": timestamp,
      "x-tc-nonce": nonce,
      "x-tc-signature": signRouterRequest(hmacKey, "POST", "/v1/events", timestamp, nonce, body),
    },
    body,
  })
}

describe("router ingress contract", () => {
  it("accepts an event once and detects duplicate and conflict payloads", async () => {
    const server = createRouterServer({
      hmacKey,
      dbPath: join(mkdtempSync(join(tmpdir(), "tc-router-")), "router.sqlite"),
      host: "127.0.0.1",
      port: 0,
      telegramChatId: "123",
      workerIntervalMs: 60_000,
      fetcher: async () => new Response("{}", { status: 200 }),
    })
    servers.push(server)
    const addr = await server.start()
    const original = event()
    const body = JSON.stringify(original)

    expect((await post(addr, body, "nonce-00000001")).status).toBe(202)
    expect((await post(addr, body, "nonce-00000002")).status).toBe(200)
    const conflict = JSON.stringify({ ...original, text: "Changed payload" })
    expect((await post(addr, conflict, "nonce-00000003")).status).toBe(409)
  })

  it("sends Telegram as plain text without parse_mode", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }))
    const server = createRouterServer({
      hmacKey,
      dbPath: join(mkdtempSync(join(tmpdir(), "tc-router-")), "router.sqlite"),
      host: "127.0.0.1",
      port: 0,
      telegramChatId: "123",
      telegramBotToken: "token",
      workerIntervalMs: 50,
      fetcher,
    })
    servers.push(server)
    const addr = await server.start()
    expect((await post(addr, JSON.stringify(event()), "nonce-00000004")).status).toBe(202)
    await new Promise((r) => setTimeout(r, 300))
    expect(fetcher.mock.calls.length).toBeGreaterThan(0)
    const request = fetcher.mock.calls[0]
    expect(String(request?.[0])).toContain("/sendMessage")
    const payload = JSON.parse(String(request?.[1]?.body)) as Record<string, unknown>
    expect(payload["chat_id"]).toBe("123")
    expect(payload["text"]).toBe("A valid broadcast")
    expect(payload["parse_mode"]).toBeUndefined()
  })
})

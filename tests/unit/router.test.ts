import { describe, expect, it, afterEach } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRouterServer } from "../../src/router/server.js"
import { signRouterRequest } from "../../src/lib/router-contract.js"
import { sha256Json } from "../../src/lib/canonical-json.js"
import type { RouterEvent } from "../../src/contracts/schemas.js"

const servers: Array<{ stop: () => Promise<void> }> = []

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()
    if (s) await s.stop()
  }
})

function makeEvent(overrides: Partial<RouterEvent> = {}): RouterEvent {
  const base = {
    schema: 1 as const,
    occurredAt: new Date().toISOString(),
    runId: "run-test-1",
    type: "finding.broadcast" as const,
    severity: "watch" as const,
    text: "test broadcast",
    refs: ["state/watchlist.json"],
    auditClaim: {
      type: "token-upside" as const,
      subject: "solana:token",
      direction: "up" as const,
      horizonHours: 72,
      verificationRule: "token.up.72h",
    },
  }
  const withoutId = { ...base, ...overrides }
  const eventId = sha256Json({
    runId: withoutId.runId,
    type: withoutId.type,
    text: withoutId.text,
    refs: withoutId.refs,
  })
  return { ...withoutId, eventId }
}

describe("router accept", () => {
  it("returns 202 then 200 for exact duplicate and 409 on conflict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-router-"))
    const hmacKey = "test-hmac-key-please-change"
    const server = createRouterServer({
      dbPath: join(dir, "router.sqlite3"),
      hmacKey,
      host: "127.0.0.1",
      port: 0,
      telegramChatId: "1",
      discordWebhookUrl: "https://example.test/webhook",
      workerIntervalMs: 60_000,
      fetcher: async () => new Response("{}", { status: 200 }),
    })
    servers.push(server)
    const addr = await server.start()
    const port = Number(new URL(addr).port)
    const event = makeEvent()
    const body = JSON.stringify(event)
    const ts = new Date().toISOString()
    const nonce = `nonce-${Date.now()}-aaaa`
    const sig = signRouterRequest(hmacKey, "POST", "/v1/events", ts, nonce, body)
    const res1 = await fetch(`http://127.0.0.1:${port}/v1/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tc-timestamp": ts,
        "x-tc-nonce": nonce,
        "x-tc-signature": sig,
      },
      body,
    })
    expect(res1.status).toBe(202)

    const ts2 = new Date().toISOString()
    const nonce2 = `nonce-${Date.now()}-bbbb`
    const sig2 = signRouterRequest(hmacKey, "POST", "/v1/events", ts2, nonce2, body)
    const res2 = await fetch(`http://127.0.0.1:${port}/v1/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tc-timestamp": ts2,
        "x-tc-nonce": nonce2,
        "x-tc-signature": sig2,
      },
      body,
    })
    expect(res2.status).toBe(200)

    const conflict = { ...event, text: "mutated" }
    const body3 = JSON.stringify(conflict)
    const ts3 = new Date().toISOString()
    const nonce3 = `nonce-${Date.now()}-cccc`
    const sig3 = signRouterRequest(hmacKey, "POST", "/v1/events", ts3, nonce3, body3)
    const res3 = await fetch(`http://127.0.0.1:${port}/v1/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tc-timestamp": ts3,
        "x-tc-nonce": nonce3,
        "x-tc-signature": sig3,
      },
      body: body3,
    })
    expect(res3.status).toBe(409)
  })
})

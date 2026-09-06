import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildGrokIntakePayload } from "../../src/orchestrator/grok-intake.js"
import { appendDeskTicket } from "../../src/router/desk-queue.js"
import {
  assertDeskPullBind,
  createDeskPullApp,
  deskPullTokenOk,
} from "../../src/router/desk-pull.js"

const TOKEN = "desk-pull-token-for-tests-ok"
const TS = "2026-09-06T18:00:00.000Z"
const MACRO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

describe("desk pull http", () => {
  it("rejects a wrong bearer and does not leak tickets", async () => {
    const logPath = join(mkdtempSync(join(tmpdir(), "tc-desk-http-")), "desk_tickets.jsonl")
    appendDeskTicket(logPath, buildGrokIntakePayload({
      id: MACRO,
      text: "Fed pause talk is the only bid.",
      ts: TS,
      severity: "watch",
    }))
    const app = createDeskPullApp({ token: TOKEN, logPath })
    const bad = await app.inject({
      method: "GET",
      url: "/desk/intake/pending",
      headers: { authorization: "Bearer wrong-token-for-tests-ok" },
    })
    expect(bad.statusCode).toBe(401)
    expect(bad.json()).toEqual({ error: "unauthorized" })
    expect(bad.body).not.toContain("Fed pause")
    const good = await app.inject({
      method: "GET",
      url: "/desk/intake/pending?limit=50",
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(good.statusCode).toBe(200)
    const body = good.json() as { tickets: Array<{ id: string; class: string; next: string }> }
    expect(body.tickets).toHaveLength(1)
    expect(body.tickets[0]?.id).toBe(MACRO)
    expect(body.tickets[0]?.class).toBe("macro")
    expect(body.tickets[0]?.next).toBe("desk_log")
    await app.close()
  })

  it("advances since_id and accepts ack without changing the log", async () => {
    const logPath = join(mkdtempSync(join(tmpdir(), "tc-desk-ack-")), "desk_tickets.jsonl")
    const first = buildGrokIntakePayload({
      id: MACRO,
      text: "macro one",
      ts: TS,
      severity: "watch",
    })
    const second = buildGrokIntakePayload({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      text: "macro two",
      ts: TS,
      severity: "watch",
    })
    appendDeskTicket(logPath, first)
    appendDeskTicket(logPath, second)
    const app = createDeskPullApp({ token: TOKEN, logPath })
    const auth = { authorization: `Bearer ${TOKEN}` }
    const page = await app.inject({
      method: "GET",
      url: `/desk/intake/pending?since_id=${MACRO}`,
      headers: auth,
    })
    expect(page.json().tickets).toHaveLength(1)
    expect(page.json().tickets[0].id).toBe(second.id)
    const ack = await app.inject({
      method: "POST",
      url: "/desk/intake/ack",
      headers: { ...auth, "content-type": "application/json" },
      payload: JSON.stringify({ ids: [MACRO] }),
    })
    expect(ack.statusCode).toBe(200)
    expect(ack.json()).toEqual({ ok: true, acked: 1 })
    const again = await app.inject({
      method: "GET",
      url: `/desk/intake/pending?since_id=${MACRO}`,
      headers: auth,
    })
    expect(again.json().tickets[0].id).toBe(second.id)
    await app.close()
  })

  it("compares bearer tokens without leaking and requires TLS off loopback", () => {
    expect(deskPullTokenOk(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(deskPullTokenOk("Bearer no", TOKEN)).toBe(false)
    expect(() => assertDeskPullBind("0.0.0.0", false)).toThrow(/TLS/)
    expect(() => assertDeskPullBind("127.0.0.1", false)).not.toThrow()
  })
})

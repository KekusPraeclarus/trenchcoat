import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FetchLike } from "../../src/collectors/market/geckoterminal.js"
import { buildGrokIntakePayload } from "../../src/orchestrator/grok-intake.js"
import { openRouterDb } from "../../src/router/db.js"
import { ensureDefaultDestinations } from "../../src/router/accept.js"
import { processDelivery } from "../../src/router/deliver.js"
import {
  GROK_MAX_ATTEMPTS,
  GROK_TOTAL_TIMEOUT_MS,
  attachGrokTelegramChatId,
  deliverGrok,
  grokBackoffSeconds,
  grokHttpRetryable,
  resolveGrokIntakeConfig,
  validateGrokIntakeUrl,
} from "../../src/router/grok-deliver.js"
import { buildBroadcastRouterEvent } from "../../src/orchestrator/router.js"

const TS = "2026-07-16T18:00:00.000Z"
const WEBHOOK = "https://grok.test/intake"
const KEY = "test-sender-key"

const ITEM = {
  severity: "watch" as const,
  text: "STAX flow is the live tell",
  refs: ["state/watchlist.json"],
  auditClaim: {
    type: "token-upside" as const,
    subject: "stax",
    direction: "up" as const,
    horizonHours: 72,
    verificationRule: "token.up.72h",
  },
}

function grokPayload() {
  return buildGrokIntakePayload({
    id: "44444444-4444-4444-8444-444444444444",
    text: ITEM.text,
    ts: TS,
    severity: ITEM.severity,
    auditClaim: ITEM.auditClaim,
    tickers: ["STAX"],
  })
}

describe("grok intake URL and auth", () => {
  it("accepts HTTPS and rejects HTTP, credentials, and fragments", () => {
    expect(validateGrokIntakeUrl(WEBHOOK).href).toBe(WEBHOOK)
    expect(() => validateGrokIntakeUrl("http://grok.test/intake")).toThrow(/HTTPS/)
    expect(() => validateGrokIntakeUrl("https://user:pass@grok.test/intake")).toThrow(/credentials/)
    expect(() => validateGrokIntakeUrl("https://grok.test/intake#x")).toThrow(/fragment/)
  })

  it("registers only when both env values are present and valid", () => {
    expect(resolveGrokIntakeConfig({ webhookUrl: WEBHOOK })).toBeUndefined()
    expect(resolveGrokIntakeConfig({ senderKey: KEY })).toBeUndefined()
    expect(resolveGrokIntakeConfig({
      webhookUrl: "http://grok.test/intake",
      senderKey: KEY,
    })).toBeUndefined()
    expect(resolveGrokIntakeConfig({ webhookUrl: WEBHOOK, senderKey: KEY })).toEqual({
      webhookUrl: WEBHOOK,
      senderKey: KEY,
    })
  })

  it("does not create a destination when env is partial", () => {
    const db = openRouterDb(join(mkdtempSync(join(tmpdir(), "tc-grok-env-")), "router.sqlite3"))
    ensureDefaultDestinations(db, {
      telegramChatId: "42",
      grokWebhookUrl: WEBHOOK,
    })
    expect(
      (db.prepare(`SELECT enabled FROM destinations WHERE id = 'grok:default'`).get() as { enabled: number }).enabled,
    ).toBe(1)
    ensureDefaultDestinations(db, { telegramChatId: "42" })
    const rows = db.prepare(`SELECT id, kind, enabled FROM destinations`).all() as Array<{
      id: string
      kind: string
      enabled: number
    }>
    expect(rows.some((row) => row.kind === "grok" && row.enabled === 1)).toBe(false)
    db.close()
  })

  it("sends Bearer auth and JSON without logging the key", async () => {
    const seen: Array<{ url: string; headers: Headers; body: string; redirect?: RequestInit["redirect"] }> = []
    const fetcher: FetchLike = async (input, init) => {
      seen.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body ?? ""),
        redirect: init?.redirect,
      })
      return new Response("{}", { status: 200 })
    }
    await deliverGrok(fetcher, WEBHOOK, KEY, grokPayload())
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe(WEBHOOK)
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`)
    expect(seen[0]?.headers.get("content-type")).toBe("application/json")
    expect(seen[0]?.redirect).toBe("error")
    expect(seen[0]?.body).not.toContain(KEY)
    const body = JSON.parse(seen[0]?.body ?? "{}") as { id: string; text: string }
    expect(body.id).toBe("44444444-4444-4444-8444-444444444444")
    expect(body.text).toBe(ITEM.text)
  })

  it("attaches telegram chat_id at delivery and omits message_id", () => {
    const attached = attachGrokTelegramChatId(grokPayload(), "99")
    expect(attached.telegram).toEqual({ chat_id: "99" })
    expect(attached.telegram).not.toHaveProperty("message_id")
  })
})

describe("grok retry policy", () => {
  it("retries 408/429/5xx and network errors only", () => {
    expect(grokHttpRetryable(408)).toBe(true)
    expect(grokHttpRetryable(429)).toBe(true)
    expect(grokHttpRetryable(503)).toBe(true)
    expect(grokHttpRetryable(400)).toBe(false)
    expect(grokHttpRetryable(401)).toBe(false)
    expect(grokHttpRetryable(403)).toBe(false)
    expect(grokBackoffSeconds(1)).toBe(1)
    expect(grokBackoffSeconds(2)).toBe(2)
    expect(grokBackoffSeconds(3, 12)).toBe(12)
  })

  it("marks 401 as a terminal delivery error", async () => {
    const fetcher: FetchLike = async () => new Response("no", { status: 401 })
    await expect(deliverGrok(fetcher, WEBHOOK, "wrong-key", grokPayload())).rejects.toMatchObject({
      message: "grok HTTP 401",
      retryable: false,
    })
  })

  it("uses a 30s abort signal", async () => {
    let signal: AbortSignal | undefined
    const fetcher: FetchLike = async (_input, init) => {
      signal = init?.signal ?? undefined
      return new Response("{}", { status: 200 })
    }
    await deliverGrok(fetcher, WEBHOOK, KEY, grokPayload())
    expect(signal?.aborted).toBe(false)
    expect(GROK_TOTAL_TIMEOUT_MS).toBe(30_000)
    expect(GROK_MAX_ATTEMPTS).toBe(3)
  })
})

describe("grok processDelivery isolation", () => {
  it("retries only grok after a 503 and skips non-broadcast events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-grok-iso-"))
    const db = openRouterDb(join(dir, "router.sqlite3"))
    const event = {
      ...buildBroadcastRouterEvent("run-grok-iso", TS, ITEM),
      channels: {
        telegram: { text: ITEM.text },
        grok: grokPayload(),
      },
    }
    db.prepare(
      `INSERT INTO destinations(id, kind, target, enabled) VALUES
       ('telegram:default', 'telegram', '42', 1),
       ('grok:default', 'grok', ?, 1)`,
    ).run(WEBHOOK)
    db.prepare(
      `INSERT INTO events(event_id, payload_hash, type, payload_json, occurred_at, run_id, accepted_at)
       VALUES (?, 'hash', ?, ?, ?, ?, 1)`,
    ).run(event.eventId, event.type, JSON.stringify(event), event.occurredAt, event.runId)
    db.prepare(
      `INSERT INTO deliveries(id, event_id, destination_id, status, attempt_count, updated_at)
       VALUES ('del-tg', ?, 'telegram:default', 'pending', 0, 1),
              ('del-grok', ?, 'grok:default', 'pending', 0, 1)`,
    ).run(event.eventId, event.eventId)

    let grokCalls = 0
    const fetcher: FetchLike = async (input) => {
      if (String(input).includes("api.telegram.org")) {
        return new Response(JSON.stringify({ result: { message_id: 7 } }), { status: 200 })
      }
      grokCalls += 1
      return new Response("busy", { status: 503 })
    }

    await processDelivery(db, fetcher, {
      id: "del-tg",
      event_id: event.eventId,
      destination_id: "telegram:default",
      status: "pending",
      attempt_count: 0,
    }, { telegramBotToken: "tg-token" })
    await processDelivery(db, fetcher, {
      id: "del-grok",
      event_id: event.eventId,
      destination_id: "grok:default",
      status: "pending",
      attempt_count: 0,
    }, { grokSenderKey: KEY, telegramChatId: "42" })

    const tg = db.prepare(`SELECT status FROM deliveries WHERE id = 'del-tg'`).get() as { status: string }
    const grok = db.prepare(`SELECT status, attempt_count, last_error FROM deliveries WHERE id = 'del-grok'`).get() as {
      status: string
      attempt_count: number
      last_error: string
    }
    expect(tg.status).toBe("delivered")
    expect(grok.status).toBe("retry")
    expect(grok.attempt_count).toBe(1)
    expect(grok.last_error).toBe("grok HTTP 503")
    expect(grokCalls).toBe(1)

    await processDelivery(db, fetcher, {
      id: "del-grok",
      event_id: event.eventId,
      destination_id: "grok:default",
      status: "retry",
      attempt_count: 1,
    }, { grokSenderKey: KEY })
    await processDelivery(db, fetcher, {
      id: "del-grok",
      event_id: event.eventId,
      destination_id: "grok:default",
      status: "retry",
      attempt_count: 2,
    }, { grokSenderKey: KEY })
    const dead = db.prepare(`SELECT status, attempt_count FROM deliveries WHERE id = 'del-grok'`).get() as {
      status: string
      attempt_count: number
    }
    expect(dead.status).toBe("dead")
    expect(dead.attempt_count).toBe(3)
    expect(grokCalls).toBe(3)
    expect(db.prepare(`SELECT status FROM deliveries WHERE id = 'del-tg'`).get()).toEqual({ status: "delivered" })
    db.close()
  })

  it("skips grok for digest, lifecycle, and topic-merged followers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-grok-skip-"))
    const db = openRouterDb(join(dir, "router.sqlite3"))
    db.prepare(
      `INSERT INTO destinations(id, kind, target, enabled) VALUES ('grok:default', 'grok', ?, 1)`,
    ).run(WEBHOOK)
    const cases = [
      {
        id: "evt-digest",
        type: "narrative.digest",
        payload: {
          schema: 1,
          eventId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          occurredAt: TS,
          runId: "run-digest",
          type: "narrative.digest",
          severity: "watch",
          text: "daily map",
          refs: [],
          channels: { telegram: { text: "daily map" } },
          dailyDigest: {
            londonDate: "2026-07-16",
            windowStart: TS,
            windowEnd: TS,
            activeNarrativeSlugs: [],
            sourceEventIds: [],
            inputHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          },
        },
      },
      {
        id: "evt-merged",
        type: "finding.broadcast",
        payload: {
          ...buildBroadcastRouterEvent("run-merged", TS, ITEM),
          channels: {},
        },
      },
      {
        id: "evt-life",
        type: "wallet.lifecycle",
        payload: {
          schema: 1,
          eventId: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          occurredAt: TS,
          runId: "run-life",
          type: "wallet.lifecycle",
          severity: "lifecycle",
          text: "wallet added",
          refs: [],
          walletTransition: {
            walletId: "w1",
            chain: "solana",
            address: "So11111111111111111111111111111111111111112",
            action: "added",
            reasonCode: "promote",
            reasonLine: "score",
          },
        },
      },
    ] as const

    let calls = 0
    const fetcher: FetchLike = async () => {
      calls += 1
      return new Response("{}", { status: 200 })
    }

    for (const row of cases) {
      db.prepare(
        `INSERT INTO events(event_id, payload_hash, type, payload_json, occurred_at, run_id, accepted_at)
         VALUES (?, 'hash', ?, ?, ?, ?, 1)`,
      ).run(row.payload.eventId, row.payload.type, JSON.stringify(row.payload), TS, row.payload.runId)
      db.prepare(
        `INSERT INTO deliveries(id, event_id, destination_id, status, attempt_count, updated_at)
         VALUES (?, ?, 'grok:default', 'pending', 0, 1)`,
      ).run(`del-${row.id}`, row.payload.eventId)
      await processDelivery(db, fetcher, {
        id: `del-${row.id}`,
        event_id: row.payload.eventId,
        destination_id: "grok:default",
        status: "pending",
        attempt_count: 0,
      }, { grokSenderKey: KEY })
      const status = db.prepare(`SELECT status FROM deliveries WHERE id = ?`).get(`del-${row.id}`) as { status: string }
      const detail = db.prepare(`SELECT detail FROM attempts WHERE delivery_id = ?`).get(`del-${row.id}`) as { detail: string }
      expect(status.status).toBe("delivered")
      expect(detail.detail).toBe("skipped-no-channel-payload")
    }
    expect(calls).toBe(0)

    const leftover = {
      ...buildBroadcastRouterEvent("run-leftover", TS, ITEM),
      channels: { grok: grokPayload(), telegram: { text: ITEM.text } },
    }
    db.prepare(
      `INSERT INTO events(event_id, payload_hash, type, payload_json, occurred_at, run_id, accepted_at)
       VALUES (?, 'hash', ?, ?, ?, ?, 1)`,
    ).run(leftover.eventId, leftover.type, JSON.stringify(leftover), TS, leftover.runId)
    db.prepare(
      `INSERT INTO deliveries(id, event_id, destination_id, status, attempt_count, updated_at)
       VALUES ('del-leftover', ?, 'grok:default', 'pending', 0, 1)`,
    ).run(leftover.eventId)
    await processDelivery(db, fetcher, {
      id: "del-leftover",
      event_id: leftover.eventId,
      destination_id: "grok:default",
      status: "pending",
      attempt_count: 0,
    }, {})
    expect(
      (db.prepare(`SELECT status FROM deliveries WHERE id = 'del-leftover'`).get() as { status: string }).status,
    ).toBe("delivered")
    expect(calls).toBe(0)
    db.close()
  })
})

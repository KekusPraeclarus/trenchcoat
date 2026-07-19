import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FetchLike } from "../../src/collectors/market/geckoterminal.js"
import { ensureArchive } from "../../src/lib/archive.js"
import { Outbox } from "../../src/lib/outbox.js"
import { buildBroadcastRouterEvent } from "../../src/orchestrator/router.js"
import { deliverStagedOutbox, retryPendingDeliveries } from "../../src/orchestrator/delivery.js"

const RUN_ID = "20260719T070000Z-crashdl"
const ITEM = {
  severity: "watch" as const,
  text: "ingress retry crash coverage",
  refs: ["state/watchlist.json"],
  auditClaim: {
    type: "token-upside" as const,
    subject: "solana:token",
    direction: "up" as const,
    horizonHours: 72,
    verificationRule: "token.up.72h",
  },
}

describe("delivery-retry crash resume", () => {
  it("persists after each attempt and resumes without duplicate POST on terminal", async () => {
    const layout = await ensureArchive(mkdtempSync(join(tmpdir(), "tc-crash-dl-")))
    const event = {
      ...buildBroadcastRouterEvent(RUN_ID, "2026-07-19T07:00:00.000Z", ITEM),
      channels: {
        telegram: { text: "Full Telegram report" },
        discord: { text: "New narrative only" },
      },
    }
    await new Outbox(join(layout.routerOutbox, RUN_ID)).stage(event)

    let calls = 0
    const fetcher: FetchLike = async () => {
      calls += 1
      if (calls === 1) return new Response("", { status: 503 })
      return new Response(JSON.stringify({ status: "accepted", delivery_id: "d-ok" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      })
    }

    const first = await deliverStagedOutbox({
      layout,
      runId: RUN_ID,
      routerUrl: "https://router.example/v1/events",
      hmacKey: "test-hmac-key-1234",
      nowIso: "2026-07-19T07:00:00.000Z",
      fetcher,
      backoffMs: 0,
    })
    expect(first[0]?.status).toBe("failed")
    expect(calls).toBe(1)

    const retry = await retryPendingDeliveries({
      layout,
      routerUrl: "https://router.example/v1/events",
      hmacKey: "test-hmac-key-1234",
      nowIso: "2026-07-19T07:02:00.000Z",
      fetcher,
      backoffMs: 0,
    })
    expect(retry.accepted).toBe(1)
    expect(calls).toBe(2)

    const third = await retryPendingDeliveries({
      layout,
      routerUrl: "https://router.example/v1/events",
      hmacKey: "test-hmac-key-1234",
      nowIso: "2026-07-19T07:03:00.000Z",
      fetcher,
      backoffMs: 0,
    })
    expect(third.attempted).toBe(0)
    expect(calls).toBe(2)
  })

  it("never posts an unrendered finding to identical channel fallbacks", async () => {
    const layout = await ensureArchive(mkdtempSync(join(tmpdir(), "tc-crash-dl-raw-")))
    await new Outbox(join(layout.routerOutbox, RUN_ID)).stage(
      buildBroadcastRouterEvent(RUN_ID, "2026-07-19T07:00:00.000Z", ITEM),
    )
    let calls = 0
    const receipts = await deliverStagedOutbox({
      layout,
      runId: RUN_ID,
      routerUrl: "https://router.example/v1/events",
      hmacKey: "test-hmac-key-1234",
      nowIso: "2026-07-19T07:00:00.000Z",
      fetcher: async () => {
        calls += 1
        return new Response("", { status: 202 })
      },
    })
    expect(receipts[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("requires rendered Telegram"),
    })
    expect(calls).toBe(0)
  })
})

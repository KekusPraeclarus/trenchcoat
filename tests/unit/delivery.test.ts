import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FetchLike } from "../../src/collectors/market/geckoterminal.js"
import { ensureArchive, type ArchiveLayout } from "../../src/lib/archive.js"
import { Outbox } from "../../src/lib/outbox.js"
import { buildBroadcastRouterEvent } from "../../src/orchestrator/router.js"
import { deliverStagedOutbox } from "../../src/orchestrator/delivery.js"

const RUN_ID = "20260717T120000Z-ab12cd34"
const NOW = "2026-07-17T12:00:00.000Z"
const ROUTER_URL = "https://router.example/v1/events"
const HMAC = "test-hmac-key-1234"

const ITEM = {
  severity: "watch" as const,
  text: "narrative is heating up",
  refs: ["state/narratives/example.md"],
  auditClaim: {
    type: "token-upside" as const,
    subject: "solana:token",
    direction: "up" as const,
    horizonHours: 72,
    verificationRule: "token.up.72h",
  },
}

async function stageOne(): Promise<ArchiveLayout> {
  const layout = await ensureArchive(mkdtempSync(join(tmpdir(), "tc-delivery-")))
  const outbox = new Outbox(join(layout.routerOutbox, RUN_ID))
  const event = {
    ...buildBroadcastRouterEvent(RUN_ID, NOW, ITEM),
    channels: {
      telegram: { text: ITEM.text },
    },
  }
  await outbox.stage(event)
  return layout
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("staged outbox delivery", () => {
  it("records an accepted receipt on HTTP 202", async () => {
    const layout = await stageOne()
    const fetcher: FetchLike = async () => jsonResponse(202, { status: "accepted", delivery_id: "d-1" })
    const receipts = await deliverStagedOutbox({
      layout, runId: RUN_ID, routerUrl: ROUTER_URL, hmacKey: HMAC, nowIso: NOW, fetcher,
    })
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.status).toBe("accepted")
    expect(receipts[0]?.deliveryId).toBe("d-1")
  })

  it("maps HTTP 409 to a conflict without retrying", async () => {
    const layout = await stageOne()
    let calls = 0
    const fetcher: FetchLike = async () => {
      calls += 1
      return new Response("", { status: 409 })
    }
    const receipts = await deliverStagedOutbox({
      layout, runId: RUN_ID, routerUrl: ROUTER_URL, hmacKey: HMAC, nowIso: NOW, fetcher,
    })
    expect(receipts[0]?.status).toBe("conflict")
    expect(calls).toBe(1)
  })

  it("skips re-delivery of an already accepted event", async () => {
    const layout = await stageOne()
    let calls = 0
    const fetcher: FetchLike = async () => {
      calls += 1
      return jsonResponse(202, { status: "accepted", delivery_id: "d-1" })
    }
    const args = { layout, runId: RUN_ID, routerUrl: ROUTER_URL, hmacKey: HMAC, nowIso: NOW, fetcher }
    await deliverStagedOutbox(args)
    const second = await deliverStagedOutbox(args)
    expect(calls).toBe(1)
    expect(second[0]?.status).toBe("accepted")
  })

  it("leaves failed deliveries retryable on the next run", async () => {
    const layout = await stageOne()
    let calls = 0
    const fetcher: FetchLike = async () => {
      calls += 1
      return new Response("", { status: 503 })
    }
    const args = { layout, runId: RUN_ID, routerUrl: ROUTER_URL, hmacKey: HMAC, nowIso: NOW, fetcher }
    const first = await deliverStagedOutbox(args)
    expect(first[0]?.status).toBe("failed")
    await deliverStagedOutbox(args)
    expect(calls).toBe(2)
  })

  it("allows topic-merged finding.broadcast without telegram payload", async () => {
    const layout = await ensureArchive(mkdtempSync(join(tmpdir(), "tc-delivery-merged-")))
    const outbox = new Outbox(join(layout.routerOutbox, RUN_ID))
    await outbox.stage({
      ...buildBroadcastRouterEvent(RUN_ID, NOW, ITEM),
      channels: {},
    })
    let calls = 0
    const fetcher: FetchLike = async () => {
      calls += 1
      return jsonResponse(202, { status: "accepted", delivery_id: "d-merged" })
    }
    const receipts = await deliverStagedOutbox({
      layout, runId: RUN_ID, routerUrl: ROUTER_URL, hmacKey: HMAC, nowIso: NOW, fetcher,
    })
    expect(receipts[0]?.status).toBe("accepted")
    expect(calls).toBe(1)
  })

  it("requires telegram payload for narrative.digest", async () => {
    const layout = await ensureArchive(mkdtempSync(join(tmpdir(), "tc-delivery-digest-")))
    const outbox = new Outbox(join(layout.routerOutbox, RUN_ID))
    const { buildNarrativeDigestRouterEvent } = await import("../../src/orchestrator/router.js")
    const event = buildNarrativeDigestRouterEvent({
      runId: RUN_ID,
      occurredAt: NOW,
      text: "**Daily narrative map — 2026-07-17**\n\n**RH — peaking**\n\nStill live.",
      londonDate: "2026-07-17",
      windowStart: "2026-07-16T19:00:00.000Z",
      windowEnd: NOW,
      activeNarrativeSlugs: ["rh-chain-meme-rotation"],
      sourceEventIds: [],
      inputHash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    })
    const { channels: _channels, ...base } = event
    await outbox.stage(base as typeof event)
    const receipts = await deliverStagedOutbox({
      layout,
      runId: RUN_ID,
      routerUrl: ROUTER_URL,
      hmacKey: HMAC,
      nowIso: NOW,
      fetcher: async () => jsonResponse(202, { status: "accepted", delivery_id: "d-x" }),
    })
    expect(receipts[0]?.status).toBe("failed")
    expect(receipts[0]?.error).toMatch(/narrative\.digest requires Telegram/)
  })
})

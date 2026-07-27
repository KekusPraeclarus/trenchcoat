import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive } from "../../src/lib/archive.js"
import { Outbox } from "../../src/lib/outbox.js"
import { buildBroadcastRouterEvent } from "../../src/orchestrator/router.js"
import { renderChannelPayloads } from "../../src/orchestrator/channel-render.js"
import { deliverStagedOutbox } from "../../src/orchestrator/delivery.js"
import type { FetchLike } from "../../src/collectors/market/geckoterminal.js"

const RUN_ID = "20260718T191500Z-crashch"
const NOW = "2026-07-18T19:15:00.000Z"
const ITEM = {
  severity: "watch" as const,
  text: "RH chain meme rotation bumped to peaking",
  refs: ["state/narratives/log.jsonl"],
  auditClaim: {
    type: "rotation" as const,
    subject: "rh-chain-meme-rotation",
    direction: "rotation" as const,
    horizonHours: 72,
    verificationRule: "rotation",
  },
}

describe("channel render crash resume", () => {
  it("does not re-POST after terminal receipt even if channels are enriched later", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-crash-ch-"))
    const agentRoot = join(root, "agent")
    mkdirSync(agentRoot, { recursive: true })
    const layout = await ensureArchive(join(root, "archive"))
    const outbox = new Outbox(join(layout.routerOutbox, RUN_ID))
    const event = buildBroadcastRouterEvent(RUN_ID, NOW, ITEM)
    await outbox.stage(event)
    await outbox.enrich({
      ...event,
      channels: {
        telegram: { text: "overview before first post" },
        discord: { text: ITEM.text },
      },
    })

    let bodies: string[] = []
    const fetcher: FetchLike = async (_url, init) => {
      bodies.push(String(init?.body ?? ""))
      return new Response(JSON.stringify({ status: "accepted", delivery_id: `d-${bodies.length}` }), {
        status: 202,
        headers: { "content-type": "application/json" },
      })
    }
    const first = await deliverStagedOutbox({
      layout,
      runId: RUN_ID,
      routerUrl: "https://router.example/v1/events",
      hmacKey: "test-hmac-key-1234",
      nowIso: NOW,
      fetcher,
    })
    expect(first[0]?.status).toBe("accepted")
    expect(JSON.parse(bodies[0] ?? "{}").channels?.telegram?.text).toBe("overview before first post")

    await outbox.enrich({
      ...event,
      channels: {
        telegram: { text: "overview after resume" },
        discord: { text: ITEM.text },
      },
    })
    bodies = []
    const second = await deliverStagedOutbox({
      layout,
      runId: RUN_ID,
      routerUrl: "https://router.example/v1/events",
      hmacKey: "test-hmac-key-1234",
      nowIso: NOW,
      fetcher,
    })
    expect(second[0]?.status).toBe("accepted")
    expect(bodies).toHaveLength(0)
  })

  it("enriches before deliver so the first POST carries channels", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-crash-ch2-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "reports", "chat"), { recursive: true })
    const layout = await ensureArchive(join(root, "archive"))
    const runId = `${RUN_ID}-b`
    const outbox = new Outbox(join(layout.routerOutbox, runId))
    const event = buildBroadcastRouterEvent(runId, NOW, ITEM)
    await outbox.stage(event)
    writeFileSync(join(agentRoot, "reports", "chat", `${runId}.md`), "# report\nnew")

    await renderChannelPayloads({
      agentRoot,
      layout,
      runId,
      nowIso: NOW,
      telegramOverview: {
        enabled: true,
        dailyCap: 10,
        usedToday: 0,
        runSession: async () => "RH still peaking. Fresh PFP lane on top.",
      },
    })

    const bodies: string[] = []
    const fetcher: FetchLike = async (_url, init) => {
      bodies.push(String(init?.body ?? ""))
      return new Response(JSON.stringify({ status: "accepted", delivery_id: "d-1" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      })
    }
    await deliverStagedOutbox({
      layout,
      runId,
      routerUrl: "https://router.example/v1/events",
      hmacKey: "test-hmac-key-1234",
      nowIso: NOW,
      fetcher,
    })
    const posted = JSON.parse(bodies[0] ?? "{}")
    expect(posted.channels?.telegram?.text).toBe("RH still peaking. Fresh PFP lane on top.")
    expect(posted.channels?.discord?.text).toBe("RH still peaking. Fresh PFP lane on top.")
  })
})

import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive, runArchiveDir } from "../../src/lib/archive.js"
import { Outbox } from "../../src/lib/outbox.js"
import { buildBroadcastRouterEvent } from "../../src/orchestrator/router.js"
import { renderChannelPayloads } from "../../src/orchestrator/channel-render.js"
import { chatReportPath } from "../../src/orchestrator/chat-report.js"

const RUN_ID = "20260718T190000Z-channel"
const NOW = "2026-07-18T19:00:00.000Z"

const ITEM = {
  severity: "notable" as const,
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

describe("Outbox.enrich", () => {
  it("allows channels when base fields are unchanged", async () => {
    const layout = await ensureArchive(mkdtempSync(join(tmpdir(), "tc-enrich-")))
    const outbox = new Outbox(join(layout.routerOutbox, RUN_ID))
    const event = buildBroadcastRouterEvent(RUN_ID, NOW, ITEM)
    await outbox.stage(event)
    await outbox.enrich({
      ...event,
      channels: {
        telegram: { text: "full report" },
        discord: { text: "short discord" },
      },
    })
    const listed = outbox.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.channels?.telegram?.text).toBe("full report")
    expect(listed[0]?.channels?.discord?.text).toBe("short discord")
  })

  it("rejects enrich that mutates base text", async () => {
    const layout = await ensureArchive(mkdtempSync(join(tmpdir(), "tc-enrich-bad-")))
    const outbox = new Outbox(join(layout.routerOutbox, RUN_ID))
    const event = buildBroadcastRouterEvent(RUN_ID, NOW, ITEM)
    await outbox.stage(event)
    await expect(outbox.enrich({
      ...event,
      text: "mutated",
      channels: { discord: { text: "x" } },
    })).rejects.toThrow(/base-field conflict/)
  })
})

describe("renderChannelPayloads", () => {
  it("uses broadcast text when no report is promoted", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-render-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "reports", "chat"), { recursive: true })
    const layout = await ensureArchive(join(root, "archive"))
    const outbox = new Outbox(join(layout.routerOutbox, RUN_ID))
    await outbox.stage(buildBroadcastRouterEvent(RUN_ID, NOW, ITEM))

    const report = await renderChannelPayloads({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      distiller: { enabled: false, dailyCap: 10, usedToday: 0 },
    })
    expect(report.rendered).toBe(1)
    const event = outbox.list()[0]
    expect(event?.channels?.telegram?.text).toBe(ITEM.text)
    expect(event?.channels?.discord?.text).toBe(ITEM.text)
  })

  it("attaches full report to telegram and distilled discord text", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-render-rep-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "reports", "chat"), { recursive: true })
    const layout = await ensureArchive(join(root, "archive"))
    const outbox = new Outbox(join(layout.routerOutbox, RUN_ID))
    await outbox.stage(buildBroadcastRouterEvent(RUN_ID, NOW, ITEM))
    const reportMd = "# Chat summary\n\nDominant lane right now: Brian Armstrong PFP flip\n"
    writeFileSync(chatReportPath(agentRoot, RUN_ID), reportMd)

    const report = await renderChannelPayloads({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      chatSummary: {
        schema: 1,
        runId: RUN_ID,
        validatedAt: NOW,
        promoted: true,
        itemIds: [],
        reportPath: `reports/chat/${RUN_ID}.md`,
        untrustedEvidence: true,
      },
      distiller: {
        enabled: true,
        dailyCap: 10,
        usedToday: 0,
        runSession: async () => "Dominant lane right now: Brian Armstrong Coinbase Man PFP flip",
      },
    })
    expect(report.usedDistill).toBe(1)
    const event = outbox.list()[0]
    expect(event?.channels?.telegram?.text).toContain("Chat summary")
    expect(event?.channels?.discord?.text).toBe(
      "Dominant lane right now: Brian Armstrong Coinbase Man PFP flip",
    )
    expect(existsSync(join(runArchiveDir(layout, RUN_ID), "channel-render-receipts.json"))).toBe(true)
  })

  it("skips already-enriched events on resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-render-resume-"))
    const agentRoot = join(root, "agent")
    mkdirSync(agentRoot, { recursive: true })
    const layout = await ensureArchive(join(root, "archive"))
    const outbox = new Outbox(join(layout.routerOutbox, RUN_ID))
    const event = buildBroadcastRouterEvent(RUN_ID, NOW, ITEM)
    await outbox.stage(event)
    await outbox.enrich({
      ...event,
      channels: { discord: { text: "already set" }, telegram: { text: "already set" } },
    })
    let launches = 0
    const second = await renderChannelPayloads({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      distiller: {
        enabled: true,
        dailyCap: 10,
        usedToday: 0,
        runSession: async () => {
          launches += 1
          return "should not run"
        },
      },
    })
    expect(second.skipped).toBe(1)
    expect(launches).toBe(0)
    expect(outbox.list()[0]?.channels?.discord?.text).toBe("already set")
  })

  it("never enriches wallet.lifecycle events", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-render-life-"))
    const agentRoot = join(root, "agent")
    mkdirSync(agentRoot, { recursive: true })
    const layout = await ensureArchive(join(root, "archive"))
    const outbox = new Outbox(join(layout.routerOutbox, RUN_ID))
    await outbox.stage({
      schema: 1,
      eventId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      occurredAt: NOW,
      runId: RUN_ID,
      type: "wallet.lifecycle",
      severity: "lifecycle",
      text: "wallet added: solana:Abc…xyz — score",
      refs: [],
      walletTransition: {
        walletId: "w1",
        chain: "solana",
        address: "So11111111111111111111111111111111111111112",
        action: "added",
        reasonCode: "promote",
        reasonLine: "score",
      },
    })
    const report = await renderChannelPayloads({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      distiller: { enabled: true, dailyCap: 10, usedToday: 0 },
    })
    expect(report.skipped).toBe(1)
    expect(outbox.list()[0]?.channels).toBeUndefined()
  })
})

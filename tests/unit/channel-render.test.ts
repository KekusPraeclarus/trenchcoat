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
const DISCORD_BUDGET = { dailyBudget: 5, urgentCeiling: 10 } as const
const TG_OFF = { enabled: false, dailyCap: 10, usedToday: 0 } as const
const DC_OFF = { enabled: false, dailyCap: 10, usedToday: 0 } as const

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
      discordBudget: DISCORD_BUDGET,
      distiller: DC_OFF,
      telegramOverview: TG_OFF,
    })
    expect(report.rendered).toBe(1)
    const event = outbox.list()[0]
    expect(event?.channels?.telegram?.text).toBe(ITEM.text)
    expect(event?.channels?.discord?.text).toBe(ITEM.text)
  })

  it("annotates single-platform rotation broadcasts as X-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-render-xonly-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "state", "narratives"), { recursive: true })
    mkdirSync(join(agentRoot, "reports", "chat"), { recursive: true })
    writeFileSync(
      join(agentRoot, "state", "narratives", "log.jsonl"),
      `${JSON.stringify({
        slug: "rh-chain-meme-rotation",
        title: "RH",
        firstSeen: NOW,
        lastSeen: NOW,
        evidence: ["twitter:@alice:1", "coingecko:trending:rh"],
        stage: "peaking",
      })}\n`,
    )
    const layout = await ensureArchive(join(root, "archive"))
    const outbox = new Outbox(join(layout.routerOutbox, RUN_ID))
    await outbox.stage(buildBroadcastRouterEvent(RUN_ID, NOW, {
      ...ITEM,
      severity: "watch",
    }))

    await renderChannelPayloads({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      discordBudget: DISCORD_BUDGET,
      distiller: DC_OFF,
      telegramOverview: TG_OFF,
    })
    const event = outbox.list()[0]
    expect(event?.channels?.telegram?.text).toContain("[X-only]")
    expect(event?.channels?.discord?.text).toContain("[X-only]")
  })

  it("attaches telegram overview and distilled discord text", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-render-rep-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "reports", "chat"), { recursive: true })
    const layout = await ensureArchive(join(root, "archive"))
    const outbox = new Outbox(join(layout.routerOutbox, RUN_ID))
    await outbox.stage(buildBroadcastRouterEvent(RUN_ID, NOW, ITEM))
    const reportMd = [
      "# Chat recall",
      "",
      "## Host summary",
      "",
      "- job: list-scan",
      "",
      "## Receipt paths",
      "",
      "- `reports/list-scan/agent.md`",
      "",
      "## Agent context (untrusted evidence)",
      "",
      "- Dominant lane: Brian Armstrong PFP flip",
      "- rh-chain-meme-rotation still peaking",
    ].join("\n")
    writeFileSync(chatReportPath(agentRoot, RUN_ID), reportMd)

    const overviewText = [
      "**Brian PFP flip**",
      "",
      "Dominant lane right now.",
      "",
      "**RH rotation**",
      "",
      "Still peaking.",
    ].join("\n")
    const discordText = "Dominant lane right now: Brian Armstrong Coinbase Man PFP flip"

    let tgLaunches = 0
    let dcLaunches = 0
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
      discordBudget: DISCORD_BUDGET,
      distiller: {
        enabled: true,
        dailyCap: 10,
        usedToday: 0,
        runSession: async () => {
          dcLaunches += 1
          return discordText
        },
      },
      telegramOverview: {
        enabled: true,
        dailyCap: 10,
        usedToday: 0,
        runSession: async () => {
          tgLaunches += 1
          return overviewText
        },
      },
      unchangedStages: [{
        slug: "rh-chain-meme-rotation",
        title: "RH",
        stage: "peaking",
      }],
    })
    expect(report.usedDistill).toBe(1)
    expect(report.usedTelegramOverview).toBe(1)
    expect(report.distillUsedToday).toBe(2)
    expect(tgLaunches).toBe(1)
    expect(dcLaunches).toBe(1)
    const event = outbox.list()[0]
    expect(event?.channels?.telegram?.text).toBe(overviewText)
    expect(event?.channels?.telegram?.text).not.toContain("Chat recall")
    expect(event?.channels?.telegram?.text).not.toContain("Receipt paths")
    expect(event?.channels?.discord?.text).toBe(discordText)
    expect(report.receipts[0]?.telegram).toBe("overview")
    expect(report.receipts[0]?.discord).toBe("distilled")
    expect(existsSync(join(runArchiveDir(layout, RUN_ID), "channel-render-receipts.json"))).toBe(true)
  })

  it("fails closed telegram overview to broadcast text", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-render-tg-fail-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "reports", "chat"), { recursive: true })
    const layout = await ensureArchive(join(root, "archive"))
    const outbox = new Outbox(join(layout.routerOutbox, RUN_ID))
    await outbox.stage(buildBroadcastRouterEvent(RUN_ID, NOW, ITEM))
    writeFileSync(
      chatReportPath(agentRoot, RUN_ID),
      "# Chat recall\n\n## Receipt paths\n\n- `reports/x.md`\n",
    )

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
      discordBudget: DISCORD_BUDGET,
      distiller: DC_OFF,
      telegramOverview: {
        enabled: true,
        dailyCap: 10,
        usedToday: 0,
        runSession: async () => "see reports/list-scan/agent.md",
      },
    })
    expect(report.usedTelegramOverview).toBe(0)
    const event = outbox.list()[0]
    expect(event?.channels?.telegram?.text).toBe(ITEM.text)
    expect(report.receipts[0]?.telegram).toBe("broadcast-text")
    expect(report.receipts[0]?.telegramReason).toBe("workspace-path")
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
      discordBudget: DISCORD_BUDGET,
      distiller: {
        enabled: true,
        dailyCap: 10,
        usedToday: 0,
        runSession: async () => {
          launches += 1
          return "should not run"
        },
      },
      telegramOverview: {
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
      discordBudget: DISCORD_BUDGET,
      distiller: { enabled: true, dailyCap: 10, usedToday: 0 },
      telegramOverview: TG_OFF,
    })
    expect(report.skipped).toBe(1)
    expect(outbox.list()[0]?.channels).toBeUndefined()
  })

  it("omits Discord when the Discord daily budget is exhausted", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-render-budget-"))
    const agentRoot = join(root, "agent")
    mkdirSync(agentRoot, { recursive: true })
    const layout = await ensureArchive(join(root, "archive"))
    const outbox = new Outbox(join(layout.routerOutbox, RUN_ID))
    await outbox.stage(buildBroadcastRouterEvent(RUN_ID, NOW, ITEM))

    const report = await renderChannelPayloads({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      discordBudget: { dailyBudget: 0, urgentCeiling: 10 },
      distiller: DC_OFF,
      telegramOverview: TG_OFF,
    })
    expect(report.rendered).toBe(1)
    expect(report.discordBudgetSkipped).toBe(1)
    const event = outbox.list()[0]
    expect(event?.channels?.telegram?.text).toBe(ITEM.text)
    expect(event?.channels?.discord).toBeUndefined()
    expect(report.receipts[0]?.discord).toBe("budget-skipped")
  })

  it("attaches Discord to at most one event per run", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-render-dedupe-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "reports", "chat"), { recursive: true })
    const layout = await ensureArchive(join(root, "archive"))
    const outbox = new Outbox(join(layout.routerOutbox, RUN_ID))
    const second = {
      ...ITEM,
      text: "Stockcoin framing is early noise on CT",
      auditClaim: {
        type: "narrative-emergence" as const,
        subject: "stockcoin-meta",
        direction: "up" as const,
        horizonHours: 72,
        verificationRule: "narrative.emergence",
      },
    }
    const third = {
      ...ITEM,
      text: "ANSEM curl is the risk-on tell if it clears 200m",
      auditClaim: {
        type: "narrative-emergence" as const,
        subject: "ansem-meme-surge",
        direction: "up" as const,
        horizonHours: 72,
        verificationRule: "narrative.emergence",
      },
    }
    await outbox.stage(buildBroadcastRouterEvent(RUN_ID, NOW, ITEM))
    await outbox.stage(buildBroadcastRouterEvent(RUN_ID, NOW, second))
    await outbox.stage(buildBroadcastRouterEvent(RUN_ID, NOW, third))
    writeFileSync(
      chatReportPath(agentRoot, RUN_ID),
      "# Chat recall\n\n## Host summary\n\n- RH owns attention. Stockcoin early. ANSEM watch.\n",
    )

    const discordText =
      "RH owns attention. Watch ANSEM for risk-on & stockcoin framing for early noise."
    let dcLaunches = 0
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
      discordBudget: DISCORD_BUDGET,
      distiller: {
        enabled: true,
        dailyCap: 10,
        usedToday: 0,
        runSession: async () => {
          dcLaunches += 1
          return discordText
        },
      },
      telegramOverview: TG_OFF,
    })

    expect(report.rendered).toBe(3)
    expect(report.usedDistill).toBe(1)
    expect(dcLaunches).toBe(1)
    const events = outbox.list()
    expect(events).toHaveLength(3)
    const withDiscord = events.filter((e) => e.channels?.discord?.text)
    expect(withDiscord).toHaveLength(1)
    expect(withDiscord[0]?.channels?.discord?.text).toBe(discordText)
    expect(events.every((e) => e.channels?.telegram?.text)).toBe(true)
    expect(report.receipts.map((r) => r.discord)).toEqual([
      "distilled",
      "run-deduped",
      "run-deduped",
    ])

    const { loadBroadcastLedger } = await import("../../src/orchestrator/broadcast-ledger.js")
    const { dayKey } = await import("../../src/orchestrator/broadcast.js")
    const ledger = loadBroadcastLedger(layout, dayKey(new Date(NOW)))
    expect(Object.keys(ledger.reservations)).toHaveLength(1)
  })
})

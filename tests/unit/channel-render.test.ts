import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive, runArchiveDir } from "../../src/lib/archive.js"
import { Outbox } from "../../src/lib/outbox.js"
import { buildBroadcastRouterEvent } from "../../src/orchestrator/router.js"
import { renderChannelPayloads, buildTopicPacket } from "../../src/orchestrator/channel-render.js"
import { chatReportPath } from "../../src/orchestrator/chat-report.js"

const RUN_ID = "20260718T190000Z-channel"
const NOW = "2026-07-18T19:00:00.000Z"
const TG_OFF = { enabled: false, dailyCap: 10, usedToday: 0 } as const

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
  it("prefers matured narrative title as subjectLabel", () => {
    const leader = buildBroadcastRouterEvent(RUN_ID, NOW, ITEM)
    const packet = buildTopicPacket({
      leader,
      members: [leader],
      activeNarratives: [{
        slug: "rh-chain-meme-rotation",
        title: "RH Chain agent infra",
        firstSeen: NOW,
        lastSeen: NOW,
        evidence: ["twitter:@a:1"],
        stage: "peaking",
        framing: "ecosystem",
        framingMaturedAt: NOW,
        framingEvidence: ["twitter:@a:1"],
      }],
    })
    expect(packet.subjectLabel).toBe("RH Chain agent infra")
    expect(packet.narrative?.framing).toBe("ecosystem")
  })
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
      telegramOverview: TG_OFF,
    })
    expect(report.rendered).toBe(1)
    const event = outbox.list()[0]
    expect(event?.channels?.telegram?.text).toBe(ITEM.text)
    expect(event?.channels?.discord?.text).toBe(ITEM.text)
    expect(event?.channels?.grok?.text).toBe(ITEM.text)
    expect(event?.channels?.grok?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    )
    expect(event?.channels?.grok?.source).toBe("narrative-agent")
    expect(event?.channels?.grok?.ts).toBe(NOW)
    expect(event?.channels?.grok?.class_hint).toBe("flow")
    expect(event?.channels?.grok?.trade_intent).toBe("watch")
    expect(report.receipts[0]?.grok).toBe("forwarded")
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
      telegramOverview: TG_OFF,
    })
    const event = outbox.list()[0]
    expect(event?.channels?.telegram?.text).toContain("[X-only]")
    expect(event?.channels?.discord?.text).toContain("[X-only]")
  })

  it("forwards the same telegram topic text to Discord", async () => {
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

    const overviewText =
      "RH chain meme rotation has fresh capital rotating into infra — watch invalidation if volume cools."

    let tgLaunches = 0
    const report = await renderChannelPayloads({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      telegramOverview: {
        enabled: true,
        dailyCap: 10,
        usedToday: 0,
        runSession: async ({ message }) => {
          tgLaunches += 1
          expect(message).toContain("<untrusted-topic-packet>")
          expect(message).not.toContain("Chat recall")
          return overviewText
        },
      },
      activeNarratives: [{
        slug: "rh-chain-meme-rotation",
        title: "RH",
        firstSeen: NOW,
        lastSeen: NOW,
        evidence: ["twitter:@a:1"],
        stage: "peaking",
      }],
    })
    expect(report.usedTelegramOverview).toBe(1)
    expect(report.topicDistillUsedToday).toBe(1)
    expect(tgLaunches).toBe(1)
    const event = outbox.list()[0]
    expect(event?.channels?.telegram?.text).toBe(overviewText)
    expect(event?.channels?.telegram?.text).not.toContain("Chat recall")
    expect(event?.channels?.telegram?.text).not.toContain("Receipt paths")
    expect(event?.channels?.discord?.text).toBe(overviewText)
    expect(event?.channels?.grok?.text).toBe(overviewText)
    expect(report.receipts[0]?.telegram).toBe("topic-deep-dive")
    expect(report.receipts[0]?.discord).toBe("forwarded")
    expect(report.receipts[0]?.grok).toBe("forwarded")
    expect(existsSync(join(runArchiveDir(layout, RUN_ID), "channel-render-receipts.json"))).toBe(true)
  })

  it("fails closed telegram topic render to packet fallback", async () => {
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
      telegramOverview: {
        enabled: true,
        dailyCap: 10,
        usedToday: 0,
        runSession: async () => "see reports/list-scan/agent.md",
      },
    })
    expect(report.usedTelegramOverview).toBe(0)
    const event = outbox.list()[0]
    expect(event?.channels?.telegram?.text).toContain(ITEM.text)
    expect(event?.channels?.discord?.text).toContain(ITEM.text)
    expect(event?.channels?.telegram?.text).not.toMatch(/\*\*[^*\n]+\*\*\s*\n/)
    expect(report.receipts[0]?.telegram).toBe("topic-fallback")
    expect(report.receipts[0]?.telegramReason).toBe("workspace-path")
  })

  it("emits one Telegram topic message per subject and merges followers", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-render-topic-group-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "reports", "chat"), { recursive: true })
    const layout = await ensureArchive(join(root, "archive"))
    const outbox = new Outbox(join(layout.routerOutbox, RUN_ID))
    const watch = {
      ...ITEM,
      severity: "watch" as const,
      text: "RH watch: leaders still firm on chain narrative",
    }
    const urgent = {
      ...ITEM,
      severity: "urgent" as const,
      text: "RH urgent: founder wallet catalyst just printed",
    }
    const other = {
      ...ITEM,
      text: "Base trust collapse accelerated after exchange delist chatter",
      auditClaim: {
        type: "narrative-fade" as const,
        subject: "base-trust-collapse",
        direction: "down" as const,
        horizonHours: 72,
        verificationRule: "narrative.fade",
      },
    }
    await outbox.stage(buildBroadcastRouterEvent(RUN_ID, NOW, watch))
    await outbox.stage(buildBroadcastRouterEvent(RUN_ID, NOW, urgent))
    await outbox.stage(buildBroadcastRouterEvent(RUN_ID, NOW, other))

    let tgLaunches = 0
    const report = await renderChannelPayloads({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      telegramOverview: {
        enabled: true,
        dailyCap: 10,
        usedToday: 0,
        runSession: async ({ message }) => {
          tgLaunches += 1
          expect(message).toContain("<untrusted-topic-packet>")
          expect(message).not.toContain("Chat recall")
          if (message.includes("subject=rh-chain-meme-rotation")) {
            expect(message).toContain("founder wallet catalyst")
            expect(message).toContain("leaders still firm")
            expect(message).toContain("otherNarratives (forbidden)")
            expect(message).toContain("base-trust-collapse")
            return "RH founder wallet catalyst is the live tell this week — leaders still firm."
          }
          expect(message).toContain("subject=base-trust-collapse")
          expect(message).toContain("otherNarratives (forbidden)")
          expect(message).toContain("rh-chain-meme-rotation")
          return "Base trust collapse is accelerating on delist chatter — fade still the frame."
        },
      },
      activeNarratives: [
        {
          slug: "rh-chain-meme-rotation",
          title: "RH",
          firstSeen: NOW,
          lastSeen: NOW,
          evidence: ["twitter:@a:1"],
          stage: "peaking",
        },
        {
          slug: "base-trust-collapse",
          title: "Base",
          firstSeen: NOW,
          lastSeen: NOW,
          evidence: ["twitter:@b:1"],
          stage: "fading",
        },
      ],
    })

    expect(tgLaunches).toBe(2)
    expect(report.usedTelegramOverview).toBe(2)
    const events = outbox.list()
    const bySubject = new Map(
      events.map((event) => [event.auditClaim?.subject, event]),
    )
    const rhEvents = events.filter((event) => event.auditClaim?.subject === "rh-chain-meme-rotation")
    expect(rhEvents).toHaveLength(2)
    const rhLeader = rhEvents.find((event) => event.channels?.telegram?.text)
    const rhFollower = rhEvents.find((event) => !event.channels?.telegram)
    expect(rhLeader?.severity).toBe("urgent")
    expect(rhLeader?.channels?.telegram?.text).toContain("founder wallet catalyst")
    expect(rhLeader?.channels?.telegram?.text).not.toMatch(/week/iu)
    expect(rhLeader?.channels?.discord?.text).toBe(rhLeader?.channels?.telegram?.text)
    expect(rhFollower?.channels?.telegram).toBeUndefined()
    expect(rhFollower?.channels?.discord).toBeUndefined()
    expect(rhFollower?.channels?.grok).toBeUndefined()
    expect(rhLeader?.channels?.grok?.text).toBe(rhLeader?.channels?.telegram?.text)
    expect(bySubject.get("base-trust-collapse")?.channels?.telegram?.text).toContain("delist chatter")
    expect(report.receipts.filter((receipt) => receipt.telegram === "topic-merged")).toHaveLength(1)
    expect(report.receipts.filter((receipt) => receipt.telegram === "topic-deep-dive")).toHaveLength(2)
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
      telegramOverview: TG_OFF,
    })
    expect(report.skipped).toBe(1)
    expect(outbox.list()[0]?.channels).toBeUndefined()
  })

  it("forwards Discord on every Telegram leader in the run", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-render-forward-"))
    const agentRoot = join(root, "agent")
    mkdirSync(agentRoot, { recursive: true })
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

    const report = await renderChannelPayloads({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      telegramOverview: TG_OFF,
    })

    expect(report.rendered).toBe(3)
    const events = outbox.list()
    expect(events).toHaveLength(3)
    const withDiscord = events.filter((e) => e.channels?.discord?.text)
    expect(withDiscord).toHaveLength(3)
    for (const event of withDiscord) {
      expect(event.channels?.discord?.text).toBe(event.channels?.telegram?.text)
      expect(event.channels?.grok?.text).toBe(event.channels?.telegram?.text)
    }
    expect(report.receipts.every((receipt) => receipt.discord === "forwarded")).toBe(true)
    expect(report.receipts.every((receipt) => receipt.grok === "forwarded")).toBe(true)
  })

  it("copies narrative tickers into the grok payload and keeps the same id on resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-render-grok-tickers-"))
    const agentRoot = join(root, "agent")
    mkdirSync(agentRoot, { recursive: true })
    const layout = await ensureArchive(join(root, "archive"))
    const outbox = new Outbox(join(layout.routerOutbox, RUN_ID))
    await outbox.stage(buildBroadcastRouterEvent(RUN_ID, NOW, {
      ...ITEM,
      severity: "urgent",
      text: "STAX flow is the live tell on the tape",
      auditClaim: {
        type: "token-upside",
        subject: "stax-flow",
        direction: "up",
        horizonHours: 72,
        verificationRule: "token.up.72h",
      },
    }))

    const first = await renderChannelPayloads({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      telegramOverview: TG_OFF,
      activeNarratives: [{
        slug: "stax-flow",
        title: "STAX flow",
        firstSeen: NOW,
        lastSeen: NOW,
        evidence: ["twitter:@a:1"],
        stage: "emerging",
        tickers: ["$stax"],
      }],
    })
    const event = outbox.list()[0]
    expect(first.rendered).toBe(1)
    expect(event?.channels?.grok?.tickers).toEqual([{ symbol: "STAX", stance: "neutral" }])
    expect(event?.channels?.grok?.trade_intent).toBe("consider")
    expect(event?.channels?.grok?.urgency).toBe("high")
    expect(event?.channels?.grok?.class_hint).toBe("catalyst")
    const id = event?.channels?.grok?.id
    expect(id).toBeTruthy()

    const second = await renderChannelPayloads({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      telegramOverview: TG_OFF,
    })
    expect(second.skipped).toBe(1)
    expect(outbox.list()[0]?.channels?.grok?.id).toBe(id)
  })
})

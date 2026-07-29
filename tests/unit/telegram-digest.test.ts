import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive, telegramDigestPath } from "../../src/lib/archive.js"
import { Outbox } from "../../src/lib/outbox.js"
import { buildBroadcastRouterEvent, buildNarrativeDigestRouterEvent } from "../../src/orchestrator/router.js"
import {
  digestWindowForLondonDate,
  digestActivityLondonDate,
  extractDigestSourceEvents,
  londonDateKey,
  londonLocalToUtcMs,
  prepareTelegramDigest,
  previousLondonDate,
  resolveDigestLondonDate,
  stageTelegramDigestEvent,
} from "../../src/orchestrator/telegram-digest.js"

const RUN_ID = "20260718T190000Z-digest"

function writeNarrativeLog(agentRoot: string, entries: unknown[]): void {
  mkdirSync(join(agentRoot, "state", "narratives"), { recursive: true })
  writeFileSync(
    join(agentRoot, "state", "narratives", "log.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  )
}

describe("London digest window", () => {
  it("selects the latest London date whose 04:00 cutoff has passed", () => {
    // 2026-03-29 is BST start in UK (01:00 UTC → 02:00 BST)
    const beforeCutoff = new Date("2026-03-29T02:59:00.000Z") // 03:59 BST
    expect(resolveDigestLondonDate(beforeCutoff)).toBe("2026-03-28")
    const afterCutoff = new Date("2026-03-29T03:00:00.000Z") // 04:00 BST
    expect(resolveDigestLondonDate(afterCutoff)).toBe("2026-03-29")
  })

  it("handles GMT winter time and prior-day windows", () => {
    const winter = new Date("2026-01-15T04:00:00.000Z") // 04:00 GMT
    expect(londonDateKey(winter)).toBe("2026-01-15")
    expect(resolveDigestLondonDate(winter)).toBe("2026-01-15")
    const window = digestWindowForLondonDate("2026-01-15")
    expect(window.windowEnd).toBe(new Date(londonLocalToUtcMs("2026-01-15", 4)).toISOString())
    expect(window.windowStart).toBe(new Date(londonLocalToUtcMs("2026-01-14", 4)).toISOString())
    expect(previousLondonDate("2026-01-15")).toBe("2026-01-14")
  })

  it("does not backfill older days on a late timer", () => {
    const late = new Date("2026-07-18T22:30:00.000Z") // 23:30 BST
    expect(resolveDigestLondonDate(late)).toBe("2026-07-18")
  })

  it("labels the digest title with the activity day, not the delivery day", () => {
    expect(digestActivityLondonDate("2026-07-29")).toBe("2026-07-28")
    expect(digestActivityLondonDate("2026-01-15")).toBe("2026-01-14")
  })
})

describe("prepareTelegramDigest", () => {
  it("records no-active-narratives without staging an event", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-digest-empty-"))
    const agentRoot = join(root, "agent")
    mkdirSync(agentRoot, { recursive: true })
    writeNarrativeLog(agentRoot, [])
    const layout = await ensureArchive(join(root, "archive"))
    const prepared = await prepareTelegramDigest({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: "2026-07-18T19:05:00.000Z",
      retentionDays: 14,
      enabled: true,
      dailyCap: 10,
      usedToday: 0,
    })
    expect(prepared.record.outcome).toBe("no-active-narratives")
    expect(existsLedger(layout, prepared.record.londonDate)).toBe(true)
    const outbox = new Outbox(join(layout.routerOutbox, RUN_ID))
    expect(outbox.list()).toHaveLength(0)
  })

  it("reuses an immutable prepared event on retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-digest-reuse-"))
    const agentRoot = join(root, "agent")
    mkdirSync(agentRoot, { recursive: true })
    writeNarrativeLog(agentRoot, [{
      slug: "rh-chain-meme-rotation",
      title: "agent title ignored",
      firstSeen: "2026-07-17T12:00:00.000Z",
      lastSeen: "2026-07-18T12:00:00.000Z",
      evidence: ["twitter:@a:1"],
      stage: "peaking",
    }])
    const layout = await ensureArchive(join(root, "archive"))
    const srcRunId = "20260717T120000Z-src"
    const outbox = new Outbox(join(layout.routerOutbox, srcRunId))
    const item = {
      severity: "notable" as const,
      text: "RH catalyst printed",
      refs: ["state/narratives/log.jsonl"],
      auditClaim: {
        type: "narrative-development" as const,
        subject: "rh-chain-meme-rotation",
        direction: "rotation" as const,
        horizonHours: 72,
        verificationRule: "narrative.development",
      },
    }
    const srcEvent = buildBroadcastRouterEvent(srcRunId, "2026-07-17T12:00:00.000Z", item)
    await outbox.stage({
      ...srcEvent,
      channels: { telegram: { text: "RH catalyst printed" } },
    })
    mkdirSync(join(layout.runs, srcRunId), { recursive: true })
    writeFileSync(join(layout.runs, srcRunId, "delivery-receipts.json"), JSON.stringify({
      receipts: [{
        eventId: srcEvent.eventId,
        status: "accepted",
        deliveredAt: "2026-07-17T21:00:00.000Z",
      }],
    }))

    let launches = 0
    const first = await prepareTelegramDigest({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: "2026-07-18T19:05:00.000Z",
      retentionDays: 14,
      enabled: true,
      dailyCap: 10,
      usedToday: 0,
      runSession: async () => {
        launches += 1
        return JSON.stringify({
          sections: [{ slug: "rh-chain-meme-rotation", body: "Peaking on wallet lore." }],
        })
      },
    })
    expect(first.record.outcome).toBe("prepared")
    expect(first.report.reused).toBe(false)
    expect(launches).toBe(1)
    expect(first.record.event?.type).toBe("narrative.digest")
    expect(first.record.event?.channels?.discord).toBeUndefined()
    expect(first.record.event?.text).toContain("**Daily narrative map — 2026-07-17**")
    expect(first.record.event?.text).toContain("**RH Chain Meme Rotation — peaking**")
    expect(first.record.event?.text).not.toContain("agent title ignored")
    expect(first.record.event?.text).not.toContain("No host-approved development")

    await stageTelegramDigestEvent({ layout, runId: RUN_ID, record: first.record })
    const second = await prepareTelegramDigest({
      agentRoot,
      layout,
      runId: "20260718T200000Z-digest-retry",
      nowIso: "2026-07-18T20:05:00.000Z",
      retentionDays: 14,
      enabled: true,
      dailyCap: 10,
      usedToday: 1,
      runSession: async () => {
        launches += 1
        return "should not run"
      },
    })
    expect(second.report.reused).toBe(true)
    expect(launches).toBe(1)
    expect(second.record.event?.eventId).toBe(first.record.event?.eventId)
    expect(second.record.event?.runId).toBe(RUN_ID)
    expect(second.record.event?.text).toBe(first.record.event?.text)
  })

  it("records no-window-developments without staging when active but quiet", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-digest-quiet-"))
    const agentRoot = join(root, "agent")
    mkdirSync(agentRoot, { recursive: true })
    writeNarrativeLog(agentRoot, [{
      slug: "base-trust-collapse",
      title: "Base Trust Collapse",
      firstSeen: "2026-07-10T12:00:00.000Z",
      lastSeen: "2026-07-17T12:00:00.000Z",
      evidence: ["twitter:@a:1"],
      stage: "fading",
    }, {
      slug: "brian-pfp-meta-collapse",
      title: "Brian PFP Meta Collapse",
      firstSeen: "2026-07-11T12:00:00.000Z",
      lastSeen: "2026-07-16T12:00:00.000Z",
      evidence: ["twitter:@b:1"],
      stage: "fading",
    }])
    const layout = await ensureArchive(join(root, "archive"))
    const prepared = await prepareTelegramDigest({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: "2026-07-18T19:05:00.000Z",
      retentionDays: 14,
      enabled: true,
      dailyCap: 10,
      usedToday: 0,
      runSession: async () => {
        throw new Error("should not distill quiet day")
      },
    })
    expect(prepared.record.outcome).toBe("no-window-developments")
    expect(prepared.record.activeNarrativeSlugs).toEqual([
      "base-trust-collapse",
      "brian-pfp-meta-collapse",
    ])
    expect(prepared.record.event).toBeUndefined()
    const outbox = new Outbox(join(layout.routerOutbox, RUN_ID))
    expect(outbox.list()).toHaveLength(0)
  })

  it("omits quiet narratives from the map when others have developments", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-digest-omit-"))
    const agentRoot = join(root, "agent")
    mkdirSync(agentRoot, { recursive: true })
    writeNarrativeLog(agentRoot, [{
      slug: "rh-chain-meme-rotation",
      title: "RH",
      firstSeen: "2026-07-17T12:00:00.000Z",
      lastSeen: "2026-07-18T12:00:00.000Z",
      evidence: ["twitter:@a:1"],
      stage: "peaking",
    }, {
      slug: "base-trust-collapse",
      title: "Base",
      firstSeen: "2026-07-10T12:00:00.000Z",
      lastSeen: "2026-07-17T12:00:00.000Z",
      evidence: ["twitter:@b:1"],
      stage: "fading",
    }])
    const layout = await ensureArchive(join(root, "archive"))
    const srcRunId = "20260717T120000Z-live"
    const outbox = new Outbox(join(layout.routerOutbox, srcRunId))
    const item = {
      severity: "notable" as const,
      text: "RH catalyst printed",
      refs: ["state/narratives/log.jsonl"],
      auditClaim: {
        type: "narrative-development" as const,
        subject: "rh-chain-meme-rotation",
        direction: "rotation" as const,
        horizonHours: 72,
        verificationRule: "narrative.development",
      },
    }
    const srcEvent = buildBroadcastRouterEvent(srcRunId, "2026-07-17T12:00:00.000Z", item)
    await outbox.stage({
      ...srcEvent,
      channels: { telegram: { text: "RH catalyst printed" } },
    })
    mkdirSync(join(layout.runs, srcRunId), { recursive: true })
    writeFileSync(join(layout.runs, srcRunId, "delivery-receipts.json"), JSON.stringify({
      receipts: [{
        eventId: srcEvent.eventId,
        status: "accepted",
        deliveredAt: "2026-07-17T21:00:00.000Z",
      }],
    }))

    const prepared = await prepareTelegramDigest({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: "2026-07-18T19:05:00.000Z",
      retentionDays: 14,
      enabled: true,
      dailyCap: 10,
      usedToday: 0,
      runSession: async ({ message }) => {
        expect(message).toContain("rh-chain-meme-rotation")
        expect(message).not.toContain("base-trust-collapse")
        return JSON.stringify({
          sections: [{ slug: "rh-chain-meme-rotation", body: "Peaking on wallet lore." }],
        })
      },
    })
    expect(prepared.record.outcome).toBe("prepared")
    expect(prepared.record.event?.text).toContain("RH Chain Meme Rotation")
    expect(prepared.record.event?.text).not.toContain("Base Trust Collapse")
    expect(prepared.record.event?.text).not.toContain("No host-approved development")
  })

  it("uses compact fallback without truncating section bodies on busy days", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-digest-cap-"))
    const agentRoot = join(root, "agent")
    mkdirSync(agentRoot, { recursive: true })
    const entries = Array.from({ length: 80 }, (_, index) => ({
      slug: `very-long-narrative-label-number-${index}`,
      title: `Title ${index}`,
      firstSeen: "2026-07-17T12:00:00.000Z",
      lastSeen: "2026-07-18T12:00:00.000Z",
      evidence: ["twitter:@a:1"],
      stage: "peaking" as const,
    }))
    writeNarrativeLog(agentRoot, entries)
    const layout = await ensureArchive(join(root, "archive"))
    const srcRunId = "20260717T120000Z-cap"
    const srcOutbox = new Outbox(join(layout.routerOutbox, srcRunId))
    const receipts: Array<{ eventId: string; status: string; deliveredAt: string }> = []
    for (const entry of entries) {
      const item = {
        severity: "notable" as const,
        text: `${entry.slug} moved`,
        refs: ["state/narratives/log.jsonl"],
        auditClaim: {
          type: "narrative-development" as const,
          subject: entry.slug,
          direction: "rotation" as const,
          horizonHours: 72,
          verificationRule: "narrative.development",
        },
      }
      const event = buildBroadcastRouterEvent(srcRunId, "2026-07-17T12:00:00.000Z", item)
      await srcOutbox.stage({
        ...event,
        channels: { telegram: { text: `${entry.slug} moved` } },
      })
      receipts.push({
        eventId: event.eventId,
        status: "accepted",
        deliveredAt: "2026-07-17T21:00:00.000Z",
      })
    }
    mkdirSync(join(layout.runs, srcRunId), { recursive: true })
    writeFileSync(join(layout.runs, srcRunId, "delivery-receipts.json"), JSON.stringify({ receipts }))

    const prepared = await prepareTelegramDigest({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: "2026-07-18T19:05:00.000Z",
      retentionDays: 14,
      enabled: true,
      dailyCap: 10,
      usedToday: 0,
      runSession: async () => {
        throw new Error("model unavailable")
      },
    })
    expect(prepared.record.outcome).toBe("prepared")
    expect(prepared.record.renderMethod).toBe("fallback")
    expect(prepared.record.event?.text).toContain("very-long-narrative-label-number-0")
    expect(prepared.record.event?.text).toContain("moved")
    const outbox = new Outbox(join(layout.routerOutbox, RUN_ID))
    expect(outbox.list()).toHaveLength(0)
    await stageTelegramDigestEvent({ layout, runId: RUN_ID, record: prepared.record })
    expect(outbox.list()).toHaveLength(1)
  })

  it("selects sources by receipt deliveredAt inside the window", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-digest-src-"))
    const agentRoot = join(root, "agent")
    mkdirSync(agentRoot, { recursive: true })
    const layout = await ensureArchive(join(root, "archive"))
    const runId = "20260717T120000Z-src"
    const outbox = new Outbox(join(layout.routerOutbox, runId))
    const item = {
      severity: "notable" as const,
      text: "RH catalyst printed",
      refs: ["state/narratives/log.jsonl"],
      auditClaim: {
        type: "narrative-development" as const,
        subject: "rh-chain-meme-rotation",
        direction: "rotation" as const,
        horizonHours: 72,
        verificationRule: "narrative.development",
      },
    }
    const event = buildBroadcastRouterEvent(runId, "2026-07-17T12:00:00.000Z", item)
    await outbox.stage({
      ...event,
      channels: { telegram: { text: "RH catalyst printed" } },
    })
    mkdirSync(join(layout.runs, runId), { recursive: true })
    writeFileSync(join(layout.runs, runId, "delivery-receipts.json"), JSON.stringify({
      receipts: [{
        eventId: event.eventId,
        status: "accepted",
        deliveredAt: "2026-07-17T21:00:00.000Z",
      }],
    }))

    const window = digestWindowForLondonDate("2026-07-18")
    const sources = extractDigestSourceEvents({
      layout,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
    })
    expect(sources).toHaveLength(1)
    expect(sources[0]?.eventId).toBe(event.eventId)
  })
})

describe("buildNarrativeDigestRouterEvent", () => {
  it("is day-keyed and Telegram-only", () => {
    const event = buildNarrativeDigestRouterEvent({
      runId: RUN_ID,
      occurredAt: "2026-07-18T19:00:00.000Z",
      text: "**Daily narrative map — 2026-07-18**\n\n**RH Chain Meme Rotation — peaking**\n\nStill live.",
      londonDate: "2026-07-18",
      windowStart: "2026-07-17T19:00:00.000Z",
      windowEnd: "2026-07-18T19:00:00.000Z",
      activeNarrativeSlugs: ["rh-chain-meme-rotation"],
      sourceEventIds: ["sha256:abc"],
      inputHash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as const,
    })
    expect(event.type).toBe("narrative.digest")
    expect(event.severity).toBe("info")
    expect(event.channels?.telegram?.text).toBe(event.text)
    expect(event.channels?.discord).toBeUndefined()
    const again = buildNarrativeDigestRouterEvent({
      runId: "other-run",
      occurredAt: "2026-07-18T19:00:00.000Z",
      text: event.text,
      londonDate: "2026-07-18",
      windowStart: event.dailyDigest!.windowStart,
      windowEnd: event.dailyDigest!.windowEnd,
      activeNarrativeSlugs: ["rh-chain-meme-rotation"],
      sourceEventIds: ["sha256:abc"],
      inputHash: event.dailyDigest!.inputHash as `sha256:${string}`,
    })
    expect(again.eventId).toBe(event.eventId)
  })
})

function existsLedger(layout: Awaited<ReturnType<typeof ensureArchive>>, londonDate: string): boolean {
  try {
    const body = readFileSync(telegramDigestPath(layout, londonDate), "utf8")
    return body.includes(londonDate)
  } catch {
    return false
  }
}

import { describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive } from "../../src/lib/archive.js"
import { Outbox } from "../../src/lib/outbox.js"
import { preArchiveRun } from "../../src/orchestrator/pre-archive.js"
import { ingestOutbox } from "../../src/orchestrator/outbox-ingest.js"
import { buildBroadcastRouterEvent } from "../../src/orchestrator/router.js"

const RUN_ID = "20260717T120000Z-ab12cd34"
const NOW = "2026-07-17T12:00:00.000Z"

const VALID_ITEM = {
  severity: "watch",
  text: "narrative is heating up",
  refs: ["state/narratives/example.md"],
  auditClaim: {
    type: "token-upside",
    subject: "solana:token",
    direction: "up",
    horizonHours: 72,
    verificationRule: "token.up.72h",
  },
}

async function scaffold(body: unknown, opts?: { inboxFile?: string }) {
  const root = mkdtempSync(join(tmpdir(), "tc-ingest-"))
  const agentRoot = join(root, "agent")
  const archiveRoot = join(root, "archive")
  const layout = await ensureArchive(archiveRoot)
  mkdirSync(join(agentRoot, "outbox"), { recursive: true })
  mkdirSync(join(agentRoot, "state", "narratives"), { recursive: true })
  writeFileSync(join(agentRoot, "state", "narratives", "example.md"), "# example\n")
  writeFileSync(join(agentRoot, "state", "narratives", "log.jsonl"), "")
  writeFileSync(join(agentRoot, "outbox", `${RUN_ID}.json`), `${JSON.stringify(body, null, 2)}\n`)
  if (opts?.inboxFile) {
    mkdirSync(join(agentRoot, "inbox", RUN_ID), { recursive: true })
    writeFileSync(join(agentRoot, "inbox", RUN_ID, opts.inboxFile), `${JSON.stringify({ ok: true })}\n`)
  }
  await preArchiveRun({
    layout,
    agentRoot,
    runId: RUN_ID,
    job: "list-scan",
    nowIso: NOW,
  })
  return { agentRoot, archiveRoot, layout }
}

describe("outbox ingest", () => {
  it("stages a valid item without a Discord budget gate", async () => {
    const s = await scaffold({ schema: 1, items: [VALID_ITEM] })
    const report = await ingestOutbox({
      agentRoot: s.agentRoot, layout: s.layout, runId: RUN_ID, nowIso: NOW,
    })
    expect(report.staged).toBe(1)
    expect(report.rejected).toBe(0)
    expect(new Outbox(join(s.layout.routerOutbox, RUN_ID)).list()).toHaveLength(1)
  })

  it("rejects a narrative claim when curated evidence is not strong", async () => {
    const narrative = {
      ...VALID_ITEM,
      auditClaim: {
        type: "narrative-emergence",
        subject: "base ai agents",
        direction: "up",
        horizonHours: 72,
        verificationRule: "narrative.emergence",
      },
    }
    const s = await scaffold({ schema: 1, items: [narrative, VALID_ITEM] })
    const report = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout: s.layout,
      runId: RUN_ID,
      nowIso: NOW,
      narrativeEvidenceQuality: {
        schema: 1,
        enabled: true,
        tier: "limited",
        reasons: ["authors-below-floor"],
        freshPosts: 2,
        independentAuthors: 1,
        promotionalShare: 0,
        primarySourceAuthors: [],
        excludedCounts: {
          "collector-status": 0,
          duplicate: 0,
          "repeated-promotion": 0,
          "promotion-pattern": 0,
          expired: 0,
        },
        thresholds: {
          maxPromotionalShare: 0.5,
          minIndependentAuthors: 2,
          minFreshPosts: 2,
        },
      },
    })
    // The token claim keeps its own market gates and still stages
    expect(report.staged).toBe(1)
    expect(report.rejects.map((r) => r.reason)).toContain(
      "narrative-evidence-quality:authors-below-floor",
    )
    const receipts = JSON.parse(readFileSync(
      join(s.archiveRoot, "runs", RUN_ID, "broadcast-rejects.json"),
      "utf8",
    )) as { rejects: { reason: string }[] }
    expect(receipts.rejects.map((r) => r.reason)).toContain(
      "narrative-evidence-quality:authors-below-floor",
    )
  })

  it("accepts a bare array of items", async () => {
    const s = await scaffold([VALID_ITEM])
    const report = await ingestOutbox({
      agentRoot: s.agentRoot, layout: s.layout, runId: RUN_ID, nowIso: NOW,
    })
    expect(report.staged).toBe(1)
  })

  it("canonicalizes same-run inbox refs to sealed archive paths before eventId", async () => {
    const item = {
      ...VALID_ITEM,
      refs: [`inbox/${RUN_ID}/twitter-fyp.json`],
    }
    const s = await scaffold({ schema: 1, items: [item] }, { inboxFile: "twitter-fyp.json" })
    const report = await ingestOutbox({
      agentRoot: s.agentRoot, layout: s.layout, runId: RUN_ID, nowIso: NOW,
    })
    expect(report.staged).toBe(1)
    expect(report.items[0]?.refs).toEqual([`archive/runs/${RUN_ID}/inbox/twitter-fyp.json`])
    const staged = new Outbox(join(s.layout.routerOutbox, RUN_ID)).list()[0]!
    expect(staged.refs).toEqual([`archive/runs/${RUN_ID}/inbox/twitter-fyp.json`])
    const expectedId = buildBroadcastRouterEvent(RUN_ID, NOW, {
      ...VALID_ITEM,
      refs: [`archive/runs/${RUN_ID}/inbox/twitter-fyp.json`],
    } as never).eventId
    expect(staged.eventId).toBe(expectedId)
  })

  it("rejects traversal and cross-run inbox refs", async () => {
    const s = await scaffold({
      schema: 1,
      items: [
        { ...VALID_ITEM, refs: ["state/narratives/../secrets.env"] },
        { ...VALID_ITEM, refs: ["inbox/other-run/twitter-fyp.json"] },
      ],
    }, { inboxFile: "twitter-fyp.json" })
    const report = await ingestOutbox({
      agentRoot: s.agentRoot, layout: s.layout, runId: RUN_ID, nowIso: NOW,
    })
    expect(report.staged).toBe(0)
    expect(report.rejected).toBe(2)
    expect(report.rejects.some((r) => /safe state-relative|ref-traversal/iu.test(r.reason))).toBe(true)
    expect(report.rejects.some((r) => r.reason === "ref-cross-run")).toBe(true)
  })

  it("rejects missing state refs and unfrozen inbox refs", async () => {
    const s = await scaffold({
      schema: 1,
      items: [
        { ...VALID_ITEM, refs: ["state/narratives/missing.md"] },
        { ...VALID_ITEM, refs: [`inbox/${RUN_ID}/not-collected.json`] },
      ],
    })
    const report = await ingestOutbox({
      agentRoot: s.agentRoot, layout: s.layout, runId: RUN_ID, nowIso: NOW,
    })
    expect(report.staged).toBe(0)
    expect(report.rejects.map((r) => r.reason)).toEqual(
      expect.arrayContaining(["ref-missing-or-mutable:state", "ref-not-frozen"]),
    )
  })

  it("rejects an item whose direction contradicts its type", async () => {
    const bad = { ...VALID_ITEM, auditClaim: { ...VALID_ITEM.auditClaim, direction: "down" } }
    const s = await scaffold({ schema: 1, items: [bad] })
    const report = await ingestOutbox({
      agentRoot: s.agentRoot, layout: s.layout, runId: RUN_ID, nowIso: NOW,
    })
    expect(report.staged).toBe(0)
    expect(report.rejected).toBe(1)
    expect(new Outbox(join(s.layout.routerOutbox, RUN_ID)).list()).toHaveLength(0)
    const rejects = JSON.parse(
      readFileSync(join(s.layout.runs, RUN_ID, "broadcast-rejects.json"), "utf8"),
    ) as { rejects: unknown[] }
    expect(rejects.rejects).toHaveLength(1)
  })

  it("stages items even when Discord daily budget would be exhausted", async () => {
    // Discord budget is applied later in renderChannelPayloads, not at ingest
    const s = await scaffold({ schema: 1, items: [VALID_ITEM] })
    const report = await ingestOutbox({
      agentRoot: s.agentRoot, layout: s.layout, runId: RUN_ID, nowIso: NOW,
    })
    expect(report.staged).toBe(1)
    expect(report.rejected).toBe(0)
  })

  it("returns an empty report when no outbox file exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-ingest-none-"))
    const layout = await ensureArchive(join(root, "archive"))
    const report = await ingestOutbox({
      agentRoot: join(root, "agent"), layout, runId: RUN_ID, nowIso: NOW,
    })
    expect(report.staged).toBe(0)
    expect(report.rejected).toBe(0)
  })

  it("rejects a broadcasts envelope instead of silently dropping it", async () => {
    const s = await scaffold({
      schema: 1,
      broadcasts: [{ slug: "x", kind: "narrative-emergence", text: "nope" }],
    })
    const report = await ingestOutbox({
      agentRoot: s.agentRoot, layout: s.layout, runId: RUN_ID, nowIso: NOW,
    })
    expect(report.staged).toBe(0)
    expect(report.rejected).toBe(1)
    expect(report.rejects[0]?.reason).toBe("invalid-envelope:use-items-not-broadcasts")
    const rejects = JSON.parse(
      readFileSync(join(s.layout.runs, RUN_ID, "broadcast-rejects.json"), "utf8"),
    ) as { rejects: Array<{ reason: string }> }
    expect(rejects.rejects[0]?.reason).toBe("invalid-envelope:use-items-not-broadcasts")
  })

  it("rejects a bare text outbox instead of silently dropping it", async () => {
    const s = await scaffold({
      schema: 1,
      runId: RUN_ID,
      text: "freeform broadcast that the host must not send",
    })
    const report = await ingestOutbox({
      agentRoot: s.agentRoot, layout: s.layout, runId: RUN_ID, nowIso: NOW,
    })
    expect(report.staged).toBe(0)
    expect(report.rejects[0]?.reason).toBe("invalid-envelope:wrap-text-in-items-array")
  })

  it("rejects rotation claims when the run is market-blind", async () => {
    const s = await scaffold({
      schema: 1,
      items: [{
        severity: "urgent",
        text: "capital rotating into base ai",
        refs: ["state/narratives/log.jsonl"],
        auditClaim: {
          type: "rotation",
          subject: "base-ai",
          direction: "rotation",
          horizonHours: 48,
          verificationRule: "rotation",
        },
      }],
    })
    const report = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout: s.layout,
      runId: RUN_ID,
      nowIso: NOW,
      marketBlind: true,
    })
    expect(report.staged).toBe(0)
    expect(report.rejected).toBe(1)
    expect(report.rejects[0]?.reason).toBe("market-blind:rotation-forbidden")
  })

  it("caps single-platform rotation and sentiment-collapse at watch", async () => {
    const s = await scaffold({
      schema: 1,
      items: [
        {
          severity: "urgent",
          text: "capital rotating into base ai hard",
          refs: ["state/narratives/log.jsonl"],
          auditClaim: {
            type: "rotation",
            subject: "base-ai",
            direction: "rotation",
            horizonHours: 48,
            verificationRule: "rotation",
          },
        },
        {
          severity: "notable",
          text: "sentiment collapsing on sol meme cluster",
          refs: ["state/narratives/log.jsonl"],
          auditClaim: {
            type: "sentiment-collapse",
            subject: "sol-meme",
            direction: "down",
            horizonHours: 24,
            verificationRule: "sentiment.collapse",
          },
        },
      ],
    })
    writeFileSync(
      join(s.agentRoot, "state", "narratives", "log.jsonl"),
      `${JSON.stringify({
        slug: "base-ai",
        title: "Base AI",
        firstSeen: NOW,
        lastSeen: NOW,
        evidence: ["twitter:@alice:1", "coingecko:trending:base-ai", "fomo:signal:1"],
        stage: "peaking",
      })}\n${JSON.stringify({
        slug: "sol-meme",
        title: "Sol meme",
        firstSeen: NOW,
        lastSeen: NOW,
        evidence: ["farcaster:@bob", "dexscreener:boost:1"],
        stage: "fading",
      })}\n`,
    )

    const report = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout: s.layout,
      runId: RUN_ID,
      nowIso: NOW,
    })
    expect(report.staged).toBe(2)
    expect(report.items.map((i) => i.severity)).toEqual(["watch", "watch"])
    expect(report.items[0]?.auditClaim.type).toBe("rotation")
    expect(report.items[1]?.auditClaim.type).toBe("sentiment-collapse")
  })

  it("keeps urgent severity when X and Farcaster independently corroborate", async () => {
    const s = await scaffold({
      schema: 1,
      items: [{
        severity: "urgent",
        text: "cross-platform rotation into base ai",
        refs: ["state/narratives/log.jsonl"],
        auditClaim: {
          type: "rotation",
          subject: "base-ai",
          direction: "rotation",
          horizonHours: 48,
          verificationRule: "rotation",
        },
      }],
    })
    writeFileSync(
      join(s.agentRoot, "state", "narratives", "log.jsonl"),
      `${JSON.stringify({
        slug: "base-ai",
        title: "Base AI",
        firstSeen: NOW,
        lastSeen: NOW,
        evidence: ["twitter:@alice:1", "farcaster:@carol"],
        stage: "peaking",
      })}\n`,
    )
    const report = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout: s.layout,
      runId: RUN_ID,
      nowIso: NOW,
    })
    expect(report.staged).toBe(1)
    expect(report.items[0]?.severity).toBe("urgent")
  })

  it("stages when worthiness approves", async () => {
    const s = await scaffold({ schema: 1, items: [VALID_ITEM] })
    const runSession = vi.fn(async () => '{"worth":true,"reason":"actionable"}')
    const report = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout: s.layout,
      runId: RUN_ID,
      nowIso: NOW,
      worthiness: {
        enabled: true,
        runSession,
        context: { job: "list-scan" },
      },
    })
    expect(report.staged).toBe(1)
    expect(report.rejected).toBe(0)
    expect(runSession).toHaveBeenCalledOnce()
  })

  it("rejects when worthiness denies", async () => {
    const s = await scaffold({ schema: 1, items: [VALID_ITEM] })
    const report = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout: s.layout,
      runId: RUN_ID,
      nowIso: NOW,
      worthiness: {
        enabled: true,
        runSession: async () => '{"worth":false,"reason":"thin FYI"}',
        context: { job: "telegram-alpha" },
      },
    })
    expect(report.staged).toBe(0)
    expect(report.rejected).toBe(1)
    expect(report.rejects[0]?.reason).toBe("worthiness:not-worth:thin FYI")
    expect(new Outbox(join(s.layout.routerOutbox, RUN_ID)).list()).toHaveLength(0)
  })

  it("fail-closes when worthiness session errors", async () => {
    const s = await scaffold({ schema: 1, items: [VALID_ITEM] })
    const report = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout: s.layout,
      runId: RUN_ID,
      nowIso: NOW,
      worthiness: {
        enabled: true,
        runSession: async () => {
          throw new Error("cli down")
        },
        context: { job: "list-scan" },
      },
    })
    expect(report.staged).toBe(0)
    expect(report.rejects[0]?.reason).toBe("worthiness:session-error")
  })

  it("skips worthiness when mechanical validation already failed", async () => {
    const runSession = vi.fn(async () => '{"worth":true,"reason":"should not run"}')
    const s = await scaffold({
      schema: 1,
      items: [{ ...VALID_ITEM, refs: ["state/narratives/missing.md"] }],
    })
    const report = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout: s.layout,
      runId: RUN_ID,
      nowIso: NOW,
      worthiness: {
        enabled: true,
        runSession,
        context: { job: "list-scan" },
      },
    })
    expect(report.staged).toBe(0)
    expect(report.rejects[0]?.reason).toMatch(/ref-missing/)
    expect(runSession).not.toHaveBeenCalled()
  })

  it("rejects duplicate subjects via mechanical gate before worthiness", async () => {
    const runSession = vi.fn(async () => '{"worth":true,"reason":"should not run for dup"}')
    const second = {
      ...VALID_ITEM,
      text: "different wording same subject",
      auditClaim: { ...VALID_ITEM.auditClaim, horizonHours: 24 },
    }
    const s = await scaffold({ schema: 1, items: [VALID_ITEM, second] })
    const report = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout: s.layout,
      runId: RUN_ID,
      nowIso: NOW,
      worthiness: {
        enabled: true,
        runSession,
        context: { job: "list-scan" },
      },
    })
    expect(report.staged).toBe(1)
    expect(report.rejects.some((entry) => entry.reason === "duplicate-subject-in-run")).toBe(true)
    expect(runSession).toHaveBeenCalledOnce()
  })

  it("skips LLM when worthiness cache hits worth true", async () => {
    const { upsertWorthinessCache, saveWorthinessCache, emptyWorthinessCache } =
      await import("../../src/orchestrator/broadcast-worthiness-cache.js")
    const s = await scaffold({ schema: 1, items: [VALID_ITEM] })
    const cache = upsertWorthinessCache(emptyWorthinessCache(), {
      auditClaim: VALID_ITEM.auditClaim as never,
      worth: true,
      reason: "cached approve",
      decidedAt: NOW,
    })
    await saveWorthinessCache(s.agentRoot, cache)
    const runSession = vi.fn(async () => '{"worth":false,"reason":"should not run"}')
    const report = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout: s.layout,
      runId: RUN_ID,
      nowIso: NOW,
      worthiness: {
        enabled: true,
        runSession,
        context: { job: "list-scan" },
      },
    })
    expect(report.staged).toBe(1)
    expect(runSession).not.toHaveBeenCalled()
  })

  it("ignores worthiness cache for narrative-development claims", async () => {
    const { upsertWorthinessCache, saveWorthinessCache, emptyWorthinessCache } =
      await import("../../src/orchestrator/broadcast-worthiness-cache.js")
    const narrative = {
      severity: "notable",
      text: "Vlad shipped agent trading on RH chain. $CASHCAT leading the first flow.",
      refs: ["state/narratives/example.md"],
      auditClaim: {
        type: "narrative-development",
        subject: "rh-chain-meme-rotation",
        direction: "rotation",
        horizonHours: 72,
        verificationRule: "narrative.development",
      },
    }
    const s = await scaffold({ schema: 1, items: [narrative] })
    writeFileSync(
      join(s.agentRoot, "state", "narratives", "log.jsonl"),
      `${JSON.stringify({
        slug: "rh-chain-meme-rotation",
        title: "Robinhood chain meme rotation",
        firstSeen: "2026-07-16T12:00:00.000Z",
        lastSeen: "2026-07-17T11:00:00.000Z",
        evidence: ["twitter:@alice"],
        stage: "peaking",
      })}\n`,
    )
    const cache = upsertWorthinessCache(emptyWorthinessCache(), {
      auditClaim: narrative.auditClaim as never,
      worth: true,
      reason: "prior development approve",
      decidedAt: NOW,
    })
    await saveWorthinessCache(s.agentRoot, cache)
    const runSession = vi.fn(async () => '{"worth":true,"reason":"must re-judge"}')
    const report = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout: s.layout,
      runId: RUN_ID,
      nowIso: NOW,
      narrativeLogBefore: [{
        slug: "rh-chain-meme-rotation",
        title: "Robinhood chain meme rotation",
        firstSeen: "2026-07-16T12:00:00.000Z",
        lastSeen: "2026-07-17T11:00:00.000Z",
        evidence: ["twitter:@alice"],
        stage: "peaking",
      }],
      narrativeEvidenceQuality: {
        schema: 1,
        enabled: true,
        tier: "strong",
        reasons: [],
        freshPosts: 8,
        independentAuthors: 5,
        promotionalShare: 0.1,
        primarySourceAuthors: [],
        excludedCounts: {
          "collector-status": 0,
          duplicate: 0,
          "repeated-promotion": 0,
          "promotion-pattern": 0,
          expired: 0,
        },
        thresholds: {
          maxPromotionalShare: 0.5,
          minIndependentAuthors: 2,
          minFreshPosts: 2,
        },
      },
      worthiness: {
        enabled: true,
        runSession,
        context: { job: "narrative-scan" },
      },
    })
    expect(report.rejects.map((entry) => entry.reason)).toEqual([])
    expect(report.staged).toBe(1)
    expect(runSession).toHaveBeenCalledOnce()
  })

  it("rejects from worthiness cache hit worth false", async () => {
    const { upsertWorthinessCache, saveWorthinessCache, emptyWorthinessCache } =
      await import("../../src/orchestrator/broadcast-worthiness-cache.js")
    const s = await scaffold({ schema: 1, items: [VALID_ITEM] })
    const cache = upsertWorthinessCache(emptyWorthinessCache(), {
      auditClaim: VALID_ITEM.auditClaim as never,
      worth: false,
      reason: "thin FYI",
      decidedAt: NOW,
    })
    await saveWorthinessCache(s.agentRoot, cache)
    const runSession = vi.fn(async () => '{"worth":true,"reason":"should not run"}')
    const report = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout: s.layout,
      runId: RUN_ID,
      nowIso: NOW,
      worthiness: {
        enabled: true,
        runSession,
        context: { job: "list-scan" },
      },
    })
    expect(report.staged).toBe(0)
    expect(report.rejects[0]?.reason).toBe("worthiness:cached-not-worth:thin FYI")
    expect(runSession).not.toHaveBeenCalled()
  })

  it("rejects items beyond the eight-item envelope cap", async () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      ...VALID_ITEM,
      text: `broadcast item ${index}`,
      auditClaim: {
        ...VALID_ITEM.auditClaim,
        subject: `subject-${index}`,
      },
    }))
    const s = await scaffold({ schema: 1, items })
    const report = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout: s.layout,
      runId: RUN_ID,
      nowIso: NOW,
    })
    expect(report.staged).toBe(8)
    expect(report.rejected).toBe(2)
    expect(report.rejects.filter((entry) => entry.reason === "outbox-items-cap")).toHaveLength(2)
  })
})

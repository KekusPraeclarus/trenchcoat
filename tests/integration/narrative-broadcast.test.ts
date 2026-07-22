import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, cpSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive } from "../../src/lib/archive.js"
import { Outbox } from "../../src/lib/outbox.js"
import { ingestOutbox } from "../../src/orchestrator/outbox-ingest.js"
import { validateAndPromoteChatReport, buildHostChatFacts } from "../../src/orchestrator/chat-report.js"
import { pruneNarrativeLog } from "../../src/orchestrator/narrative-log.js"
import { resolveSealedNarrativeFreshness } from "../../src/orchestrator/index-reconcile.js"
import { runJob } from "../../src/orchestrator/run.js"

const RUN_ID = "20260717T180000Z-narrativ"
const NOW = "2026-07-17T18:00:00.000Z"

const NARRATIVE_ITEM = {
  severity: "watch",
  text: "new narrative popping: base ai agents. still early.",
  refs: ["state/narratives/log.jsonl"],
  auditClaim: {
    type: "narrative-emergence",
    subject: "base-ai",
    direction: "up",
    horizonHours: 72,
    verificationRule: "narrative.emergence",
  },
}

describe("narrative broadcast staging", () => {
  it("stages a narrative-emergence proposal through ingestOutbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-narr-bcast-"))
    const agentRoot = join(root, "agent")
    const layout = await ensureArchive(join(root, "archive"))
    mkdirSync(join(agentRoot, "outbox"), { recursive: true })
    mkdirSync(join(agentRoot, "state", "narratives"), { recursive: true })
    // Empty log — subject is a new slug (status-quo gate allows)
    writeFileSync(join(agentRoot, "state", "narratives", "log.jsonl"), "")
    writeFileSync(
      join(agentRoot, "outbox", `${RUN_ID}.json`),
      `${JSON.stringify({ schema: 1, items: [NARRATIVE_ITEM] }, null, 2)}\n`,
    )

    const prune = await pruneNarrativeLog({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      retentionDays: 14,
    })
    expect(prune.kept).toBe(0)

    const report = await ingestOutbox({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      narrativeLogBefore: [],
    })
    expect(report.staged).toBe(1)
    expect(report.rejected).toBe(0)
    expect(report.items[0]?.auditClaim.type).toBe("narrative-emergence")
    const staged = new Outbox(join(layout.routerOutbox, RUN_ID)).list()
    expect(staged).toHaveLength(1)
    expect(staged[0]?.type).toBe("finding.broadcast")
  })

  it("rejects same-stage re-sighting of an already-peaking narrative", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-narr-dedupe-"))
    const agentRoot = join(root, "agent")
    const layout = await ensureArchive(join(root, "archive"))
    mkdirSync(join(agentRoot, "outbox"), { recursive: true })
    mkdirSync(join(agentRoot, "state", "narratives"), { recursive: true })
    const prior = {
      slug: "rh-chain-meme-rotation",
      title: "Robinhood chain meme rotation",
      firstSeen: NOW,
      lastSeen: NOW,
      evidence: ["twitter:@alice:1"],
      stage: "peaking" as const,
    }
    writeFileSync(join(agentRoot, "state", "narratives", "log.jsonl"), `${JSON.stringify(prior)}\n`)
    writeFileSync(
      join(agentRoot, "outbox", `${RUN_ID}.json`),
      `${JSON.stringify({
        schema: 1,
        items: [{
          severity: "watch",
          text: "RH chain meme rotation bumped to peaking on this scan",
          refs: ["state/narratives/log.jsonl"],
          auditClaim: {
            type: "narrative-emergence",
            subject: "rh-chain-meme-rotation",
            direction: "up",
            horizonHours: 72,
            verificationRule: "narrative.emergence",
          },
        }],
      }, null, 2)}\n`,
    )

    const report = await ingestOutbox({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      narrativeLogBefore: [prior],
      narrativeLogAfter: [prior],
    })
    expect(report.staged).toBe(0)
    expect(report.rejected).toBe(1)
    expect(report.rejects[0]?.reason).toMatch(/narrative-unchanged-stage|status-quo-narrative-stage/)
  })

  it("allows a notable same-stage development with a legacy emergence claim", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-narr-development-"))
    const agentRoot = join(root, "agent")
    const layout = await ensureArchive(join(root, "archive"))
    mkdirSync(join(agentRoot, "outbox"), { recursive: true })
    mkdirSync(join(agentRoot, "state", "narratives"), { recursive: true })
    const prior = {
      slug: "pons-launchpad-attention",
      title: "PONS launchpad attention",
      firstSeen: NOW,
      lastSeen: NOW,
      evidence: ["twitter:@alice:1"],
      stage: "emerging" as const,
    }
    writeFileSync(join(agentRoot, "state", "narratives", "log.jsonl"), `${JSON.stringify(prior)}\n`)
    writeFileSync(
      join(agentRoot, "outbox", `${RUN_ID}.json`),
      `${JSON.stringify({
        schema: 1,
        items: [{
          severity: "notable",
          text: "PONS protocol revenue hit $169K in 24h while FDV held near $26M",
          refs: ["state/narratives/log.jsonl"],
          auditClaim: {
            type: "narrative-emergence",
            subject: "pons-launchpad-attention",
            direction: "up",
            horizonHours: 72,
            verificationRule: "narrative.emergence",
          },
        }],
      }, null, 2)}\n`,
    )

    const report = await ingestOutbox({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      narrativeLogBefore: [prior],
      narrativeLogAfter: [prior],
    })
    expect(report.staged).toBe(1)
    expect(report.rejected).toBe(0)
  })

  it("allows a broadcast when narrative heat changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-narr-heat-"))
    const agentRoot = join(root, "agent")
    const layout = await ensureArchive(join(root, "archive"))
    mkdirSync(join(agentRoot, "outbox"), { recursive: true })
    mkdirSync(join(agentRoot, "state", "narratives"), { recursive: true })
    const before = {
      slug: "rh-chain-meme-rotation",
      title: "Robinhood chain meme rotation",
      firstSeen: NOW,
      lastSeen: NOW,
      evidence: ["twitter:@alice:1"],
      stage: "peaking" as const,
    }
    const after = { ...before, stage: "fading" as const }
    writeFileSync(join(agentRoot, "state", "narratives", "log.jsonl"), `${JSON.stringify(after)}\n`)
    writeFileSync(
      join(agentRoot, "outbox", `${RUN_ID}.json`),
      `${JSON.stringify({
        schema: 1,
        items: [{
          severity: "notable",
          text: "RH rotation cooling into fade after the perps war churn",
          refs: ["state/narratives/log.jsonl"],
          auditClaim: {
            type: "narrative-fade",
            subject: "rh-chain-meme-rotation",
            direction: "down",
            horizonHours: 72,
            verificationRule: "narrative.fade",
          },
        }],
      }, null, 2)}\n`,
    )

    const report = await ingestOutbox({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      narrativeLogBefore: [before],
      narrativeLogAfter: [after],
    })
    expect(report.staged).toBe(1)
    expect(report.rejected).toBe(0)
  })

  it("caps X-only rotation at watch during ingest", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-narr-xonly-"))
    const agentRoot = join(root, "agent")
    const layout = await ensureArchive(join(root, "archive"))
    mkdirSync(join(agentRoot, "outbox"), { recursive: true })
    mkdirSync(join(agentRoot, "state", "narratives"), { recursive: true })
    writeFileSync(
      join(agentRoot, "state", "narratives", "log.jsonl"),
      `${JSON.stringify({
        slug: "base-ai",
        title: "Base AI",
        firstSeen: NOW,
        lastSeen: NOW,
        evidence: ["twitter:@alice:1", "fomo:signal:ignored"],
        stage: "emerging",
      })}\n`,
    )
    writeFileSync(
      join(agentRoot, "outbox", `${RUN_ID}.json`),
      `${JSON.stringify({
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
      }, null, 2)}\n`,
    )

    const report = await ingestOutbox({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
    })
    expect(report.staged).toBe(1)
    expect(report.items[0]?.severity).toBe("watch")
  })

  it("promotes a chat-summary proposal after ingestOutbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-narr-chat-"))
    const agentRoot = join(root, "agent")
    const layout = await ensureArchive(join(root, "archive"))
    mkdirSync(join(agentRoot, "outbox"), { recursive: true })
    mkdirSync(join(agentRoot, "state", "narratives"), { recursive: true })
    mkdirSync(join(agentRoot, "reports", RUN_ID), { recursive: true })
    writeFileSync(
      join(agentRoot, "state", "narratives", "log.jsonl"),
      `${JSON.stringify({
        slug: "base-ai",
        title: "Base AI",
        firstSeen: NOW,
        lastSeen: NOW,
        evidence: ["twitter:@alice:1"],
        stage: "emerging",
      })}\n`,
    )
    writeFileSync(
      join(agentRoot, "outbox", `${RUN_ID}.json`),
      `${JSON.stringify({ schema: 1, items: [NARRATIVE_ITEM] }, null, 2)}\n`,
    )
    writeFileSync(
      join(agentRoot, "reports", RUN_ID, "chat-summary.json"),
      `${JSON.stringify({
        schema: 1,
        runId: RUN_ID,
        proposedAt: NOW,
        itemIds: ["item:0"],
        context: [
          "base-ai is a new slug this run",
          "log.jsonl carries the rolling narrative evidence",
          "broadcast text stays host-validated",
        ],
        sources: ["state/narratives/log.jsonl"],
      }, null, 2)}\n`,
    )

    const ingest = await ingestOutbox({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
    })
    const receipt = await validateAndPromoteChatReport({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      ingest,
      facts: buildHostChatFacts({
        job: "narrative-scan",
        runStatus: "complete",
        collection: { collectionStatus: "completed" },
      }),
    })
    expect(receipt.promoted).toBe(true)
    expect(existsSync(join(agentRoot, "reports", "chat", `${RUN_ID}.md`))).toBe(true)
    expect(readFileSync(join(agentRoot, "reports", "chat", `${RUN_ID}.md`), "utf8"))
      .toContain(NARRATIVE_ITEM.text)
  })

  it("runs narrative-scan host prune under skip-agent dry collect", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-narr-run-"))
    const agentRoot = join(root, "agent")
    cpSync(join(process.cwd(), "agent"), agentRoot, { recursive: true })
    mkdirSync(join(agentRoot, "state", "narratives"), { recursive: true })

    const nowMs = Date.now()
    const iso = (offsetDays: number) => new Date(nowMs - offsetDays * 86_400_000).toISOString()
    writeFileSync(
      join(agentRoot, "state", "narratives", "log.jsonl"),
      `${JSON.stringify({
        slug: "keep-me",
        title: "Keep",
        firstSeen: iso(5),
        lastSeen: iso(1),
        evidence: ["twitter:@x:1"],
        stage: "peaking",
      })}\n${JSON.stringify({
        slug: "purge-me",
        title: "Purge",
        firstSeen: iso(40),
        lastSeen: iso(20),
        evidence: ["twitter:@y:1"],
        stage: "fading",
      })}\n`,
    )
    const staleIndex = [
      "# INDEX",
      "",
      "stale rollup stamped yesterday — must be rewritten on success",
      "",
      "## Tokens",
      "",
      "(none yet)",
      "",
      "## Narratives",
      "",
      "purge-me — fading, Purge, 2026-01-01 → state/narratives/log.jsonl",
      "",
    ].join("\n")
    writeFileSync(join(agentRoot, "state", "INDEX.md"), staleIndex)

    const result = await runJob({
      job: "narrative-scan",
      paths: { agentRoot, archiveRoot: join(root, "archive") },
      skipAgent: true,
      dryCollect: true,
    })
    expect(result.exitCode).toBe(0)
    expect(result.journal?.phase).toBe("complete")
    const prunePath = join(agentRoot, "reports", result.runId, "narrative-log-prune.json")
    expect(existsSync(prunePath)).toBe(true)
    const prune = JSON.parse(readFileSync(prunePath, "utf8")) as {
      kept: number
      purged: number
    }
    expect(prune.kept).toBe(1)
    expect(prune.purged).toBe(1)
    const chatPath = join(agentRoot, "reports", "chat", `${result.runId}.md`)
    expect(existsSync(chatPath)).toBe(true)
    expect(readFileSync(chatPath, "utf8")).toContain("job: narrative-scan")

    const indexBody = readFileSync(join(agentRoot, "state", "INDEX.md"), "utf8")
    expect(indexBody).toContain("keep-me")
    expect(indexBody).not.toContain("purge-me")
    expect(indexBody).not.toContain("stale rollup stamped yesterday")

    const archiveReceipt = join(root, "archive", "runs", result.runId, "index-reconcile-receipt.json")
    const reportReceipt = join(agentRoot, "reports", result.runId, "index-reconcile-receipt.json")
    expect(existsSync(archiveReceipt)).toBe(true)
    expect(existsSync(reportReceipt)).toBe(true)
    const receipt = JSON.parse(readFileSync(archiveReceipt, "utf8")) as {
      schema: number
      kind: string
      runId: string
      job: string
      beforeHash: string | null
      afterHash: string
      changed: boolean
      sources: { narrativesCount: number }
      sealedNarrativeFreshness: unknown
      freshnessNote: string
    }
    expect(receipt.schema).toBe(1)
    expect(receipt.kind).toBe("index-reconcile")
    expect(receipt.runId).toBe(result.runId)
    expect(receipt.job).toBe("narrative-scan")
    expect(receipt.beforeHash).toMatch(/^sha256:/)
    expect(receipt.afterHash).toMatch(/^sha256:/)
    expect(receipt.changed).toBe(true)
    expect(receipt.sources.narrativesCount).toBe(1)
    expect(receipt.freshnessNote).toContain("sealed complete narrative-scan")

    const freshness = await resolveSealedNarrativeFreshness({
      archiveRoot: join(root, "archive"),
      nowIso: new Date().toISOString(),
    })
    expect(freshness.lastCompleteRunId).toBe(result.runId)
    expect(freshness.lastCompleteAt).toBeTruthy()
    expect(typeof freshness.ageSec).toBe("number")
  })

  it("leaves INDEX unchanged when a non-narrative job skips reconcile", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-narr-skip-index-"))
    const agentRoot = join(root, "agent")
    cpSync(join(process.cwd(), "agent"), agentRoot, { recursive: true })
    const frozen = [
      "# INDEX",
      "",
      "authoritative frozen rollup",
      "",
      "## Tokens",
      "",
      "(none yet)",
      "",
      "## Narratives",
      "",
      "(none yet)",
      "",
    ].join("\n")
    writeFileSync(join(agentRoot, "state", "INDEX.md"), frozen)

    const result = await runJob({
      job: "list-scan",
      paths: { agentRoot, archiveRoot: join(root, "archive") },
      skipAgent: true,
      dryCollect: true,
    })
    expect(result.exitCode).toBe(0)
    expect(result.journal?.phase).toBe("complete")
    expect(readFileSync(join(agentRoot, "state", "INDEX.md"), "utf8")).toBe(frozen)
    expect(existsSync(
      join(root, "archive", "runs", result.runId, "index-reconcile-receipt.json"),
    )).toBe(false)
  })
})

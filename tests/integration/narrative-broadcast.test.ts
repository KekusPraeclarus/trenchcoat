import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, cpSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive } from "../../src/lib/archive.js"
import { Outbox } from "../../src/lib/outbox.js"
import { ingestOutbox } from "../../src/orchestrator/outbox-ingest.js"
import { validateAndPromoteChatReport } from "../../src/orchestrator/chat-report.js"
import { pruneNarrativeLog } from "../../src/orchestrator/narrative-log.js"
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

    const prune = await pruneNarrativeLog({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      retentionDays: 14,
    })
    expect(prune.kept).toBe(1)

    const report = await ingestOutbox({
      agentRoot,
      layout,
      runId: RUN_ID,
      dailyBudget: 5,
      urgentCeiling: 10,
      nowIso: NOW,
    })
    expect(report.staged).toBe(1)
    expect(report.rejected).toBe(0)
    expect(report.items[0]?.auditClaim.type).toBe("narrative-emergence")
    const staged = new Outbox(join(layout.routerOutbox, RUN_ID)).list()
    expect(staged).toHaveLength(1)
    expect(staged[0]?.type).toBe("finding.broadcast")
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
      dailyBudget: 5,
      urgentCeiling: 10,
      nowIso: NOW,
    })
    const receipt = await validateAndPromoteChatReport({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      ingest,
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
  })
})

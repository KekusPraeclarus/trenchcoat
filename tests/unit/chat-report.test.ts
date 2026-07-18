import { describe, expect, it } from "vitest"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive } from "../../src/lib/archive.js"
import { ingestOutbox } from "../../src/orchestrator/outbox-ingest.js"
import {
  chatReportPath,
  stagedBroadcastEventIds,
  validateAndPromoteChatReport,
} from "../../src/orchestrator/chat-report.js"
import { ChatSummaryFileSchema } from "../../src/contracts/schemas.js"

const RUN_ID = "20260717T120000Z-ab12cd34"
const NOW = "2026-07-17T12:00:00.000Z"

const BROADCAST_ITEM = {
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
} as const

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), "tc-chat-report-"))
  const agentRoot = join(root, "agent")
  const archiveRoot = join(root, "archive")
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
    `${JSON.stringify({ schema: 1, items: [BROADCAST_ITEM] }, null, 2)}\n`,
  )
  return { root, agentRoot, archiveRoot }
}

function writeProposal(agentRoot: string, body: unknown) {
  writeFileSync(
    join(agentRoot, "reports", RUN_ID, "chat-summary.json"),
    `${JSON.stringify(body, null, 2)}\n`,
  )
}

function validProposal(itemIds: string[] = ["item:0"]) {
  return {
    schema: 1,
    runId: RUN_ID,
    proposedAt: NOW,
    itemIds,
    context: [
      "base-ai narrative is newly appended this run",
      "evidence in state/narratives/log.jsonl and inbox snapshots",
      "operator should watch for follow-through over 72h",
    ],
    sources: ["state/narratives/log.jsonl"],
  }
}

describe("chat summary schema", () => {
  it("accepts a bounded proposal", () => {
    const parsed = ChatSummaryFileSchema.parse(validProposal())
    expect(parsed.context).toHaveLength(3)
    expect(parsed.itemIds[0]).toBe("item:0")
  })
})

describe("validateAndPromoteChatReport", () => {
  it("promotes a valid summary with host-rendered broadcast text", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    writeProposal(s.agentRoot, validProposal())
    const ingest = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      dailyBudget: 5,
      urgentCeiling: 10,
      nowIso: NOW,
    })
    expect(ingest.staged).toBe(1)

    const receipt = await validateAndPromoteChatReport({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      ingest,
    })
    expect(receipt.promoted).toBe(true)
    expect(receipt.reportPath).toBe(`reports/chat/${RUN_ID}.md`)
    expect(receipt.untrustedEvidence).toBe(true)

    const report = readFileSync(chatReportPath(s.agentRoot, RUN_ID), "utf8")
    expect(report).toContain(BROADCAST_ITEM.text)
    expect(report).toContain("base-ai narrative is newly appended this run")
    expect(existsSync(join(layout.runs, RUN_ID, "chat-summary-receipt.json"))).toBe(true)
    expect(existsSync(join(layout.runs, RUN_ID, "chat-report.md"))).toBe(true)
  })

  it("rejects a missing proposal without failing the run path", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    const ingest = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      dailyBudget: 5,
      urgentCeiling: 10,
      nowIso: NOW,
    })
    const receipt = await validateAndPromoteChatReport({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      ingest,
    })
    expect(receipt.promoted).toBe(false)
    expect(receipt.reason).toBe("proposal-missing")
    expect(existsSync(chatReportPath(s.agentRoot, RUN_ID))).toBe(false)
  })

  it("does not promote when no broadcasts were staged", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    writeProposal(s.agentRoot, validProposal())
    const receipt = await validateAndPromoteChatReport({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      ingest: { staged: 0, rejected: 0, rejects: [], items: [] },
    })
    expect(receipt.promoted).toBe(false)
    expect(receipt.reason).toBe("no-staged-broadcasts")
    expect(existsSync(chatReportPath(s.agentRoot, RUN_ID))).toBe(false)
  })

  it("rejects mismatched item ids", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    const ingest = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      dailyBudget: 5,
      urgentCeiling: 10,
      nowIso: NOW,
    })
    const stagedIds = stagedBroadcastEventIds(RUN_ID, NOW, ingest.items)
    writeProposal(s.agentRoot, validProposal(["item:1"]))
    const receipt = await validateAndPromoteChatReport({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      ingest,
    })
    expect(receipt.promoted).toBe(false)
    expect(receipt.reason).toBe("item-index-out-of-range")
    expect(receipt.itemIds).toEqual(stagedIds)
  })

  it("rejects source paths that escape the agent tree", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    const ingest = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      dailyBudget: 5,
      urgentCeiling: 10,
      nowIso: NOW,
    })
    writeProposal(s.agentRoot, {
      ...validProposal(),
      sources: ["inbox/x/../../../outside.md"],
    })
    const receipt = await validateAndPromoteChatReport({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      ingest,
    })
    expect(receipt.promoted).toBe(false)
    expect(receipt.reason).toBe("source-path-invalid")
  })

  it("rejects symlinked source paths", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    const ingest = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      dailyBudget: 5,
      urgentCeiling: 10,
      nowIso: NOW,
    })
    const outside = join(s.root, "outside.md")
    writeFileSync(outside, "secret\n")
    const linkPath = join(s.agentRoot, "state", "narratives", "link.md")
    symlinkSync(outside, linkPath)
    writeProposal(s.agentRoot, {
      ...validProposal(),
      sources: ["state/narratives/link.md"],
    })
    const receipt = await validateAndPromoteChatReport({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      ingest,
    })
    expect(receipt.promoted).toBe(false)
    expect(receipt.reason).toBe("source-path-invalid")
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
  })

  it("rejects oversize rendered reports", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    const ingest = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      dailyBudget: 5,
      urgentCeiling: 10,
      nowIso: NOW,
    })
    writeProposal(s.agentRoot, {
      ...validProposal(),
      context: Array.from({ length: 8 }, () => "x".repeat(280)),
    })
    const receipt = await validateAndPromoteChatReport({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      ingest,
      maxReportBytes: 500,
    })
    expect(receipt.promoted).toBe(false)
    expect(receipt.reason).toBe("report-too-large")
  })

  it("ignores direct agent bypass files and blocks canary promotion", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    const ingest = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      dailyBudget: 5,
      urgentCeiling: 10,
      nowIso: NOW,
    })
    writeProposal(s.agentRoot, validProposal())
    mkdirSync(join(s.agentRoot, "reports", "chat"), { recursive: true })
    writeFileSync(chatReportPath(s.agentRoot, RUN_ID), "agent bypass\n")

    const receipt = await validateAndPromoteChatReport({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      ingest,
      blockPromotion: true,
    })
    expect(receipt.promoted).toBe(false)
    expect(receipt.reason).toBe("promotion-blocked")
    expect(existsSync(chatReportPath(s.agentRoot, RUN_ID))).toBe(false)
  })

  it("removes agent bypass files before promoting a valid summary", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    const ingest = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      dailyBudget: 5,
      urgentCeiling: 10,
      nowIso: NOW,
    })
    writeProposal(s.agentRoot, validProposal())
    mkdirSync(join(s.agentRoot, "reports", "chat"), { recursive: true })
    writeFileSync(chatReportPath(s.agentRoot, RUN_ID), "agent bypass\n")

    const receipt = await validateAndPromoteChatReport({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      ingest,
    })
    expect(receipt.promoted).toBe(true)
    const report = readFileSync(chatReportPath(s.agentRoot, RUN_ID), "utf8")
    expect(report).not.toContain("agent bypass")
    expect(report).toContain(BROADCAST_ITEM.text)
  })
})

describe("promoteResearchChatReport", () => {
  it("promotes a bounded chat-summary.md into reports/chat", async () => {
    const { promoteResearchChatReport } = await import("../../src/orchestrator/chat-report.js")
    const root = mkdtempSync(join(tmpdir(), "tc-research-chat-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "reports", RUN_ID), { recursive: true })
    writeFileSync(
      join(agentRoot, "reports", RUN_ID, "chat-summary.md"),
      "## Findings\n\nToken looks early but liquid enough to watch.\n",
    )
    const layout = await ensureArchive(archiveRoot)
    const result = await promoteResearchChatReport({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      subject: "solana:So11111111111111111111111111111111111111112",
    })
    expect(result).toEqual({
      promoted: true,
      reportPath: `reports/chat/${RUN_ID}.md`,
    })
    const report = readFileSync(chatReportPath(agentRoot, RUN_ID), "utf8")
    expect(report).toContain("Research chat summary")
    expect(report).toContain("Token looks early")
    expect(existsSync(join(layout.runs, RUN_ID, "research-chat-receipt.json"))).toBe(true)
  })

  it("rejects missing or oversize proposals", async () => {
    const { promoteResearchChatReport } = await import("../../src/orchestrator/chat-report.js")
    const root = mkdtempSync(join(tmpdir(), "tc-research-chat-miss-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "reports", RUN_ID), { recursive: true })
    const layout = await ensureArchive(archiveRoot)
    const missing = await promoteResearchChatReport({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      subject: "solana:token",
    })
    expect(missing.promoted).toBe(false)

    writeFileSync(join(agentRoot, "reports", RUN_ID, "chat-summary.md"), "x".repeat(2_000))
    const oversize = await promoteResearchChatReport({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      subject: "solana:token",
      maxReportBytes: 100,
    })
    expect(oversize.promoted).toBe(false)
  })
})

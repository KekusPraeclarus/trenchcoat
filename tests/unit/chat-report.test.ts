import { describe, expect, it } from "vitest"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive } from "../../src/lib/archive.js"
import { ingestOutbox } from "../../src/orchestrator/outbox-ingest.js"
import {
  buildHostChatFacts,
  chatReportPath,
  stagedBroadcastEventIds,
  validateAndPromoteChatReport,
} from "../../src/orchestrator/chat-report.js"
import { retainWorkspaceArtifacts } from "../../src/orchestrator/retention.js"
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

function scaffold(withOutbox = true) {
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
  if (withOutbox) {
    writeFileSync(
      join(agentRoot, "outbox", `${RUN_ID}.json`),
      `${JSON.stringify({ schema: 1, items: [BROADCAST_ITEM] }, null, 2)}\n`,
    )
  }
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

function baseFacts(job = "narrative-scan") {
  return buildHostChatFacts({
    job,
    runStatus: "complete",
    collection: {
      collectionStatus: "completed",
      postCount: 12,
      snapshotNames: ["twitter-trending"],
    },
  })
}

describe("chat summary schema", () => {
  it("accepts a bounded proposal with optional empty itemIds", () => {
    const parsed = ChatSummaryFileSchema.parse(validProposal())
    expect(parsed.context).toHaveLength(3)
    expect(parsed.itemIds[0]).toBe("item:0")
    const emptyItems = ChatSummaryFileSchema.parse({
      ...validProposal([]),
      itemIds: [],
    })
    expect(emptyItems.itemIds).toEqual([])
  })
})

describe("validateAndPromoteChatReport", () => {
  it("promotes a valid summary with host facts before agent context", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    writeProposal(s.agentRoot, validProposal())
    const ingest = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
    })
    expect(ingest.staged).toBe(1)

    const receipt = await validateAndPromoteChatReport({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      ingest,
      facts: baseFacts(),
    })
    expect(receipt.promoted).toBe(true)
    expect(receipt.proposalAccepted).toBe(true)
    expect(receipt.hostOnly).toBe(false)
    expect(receipt.reportPath).toBe(`reports/chat/${RUN_ID}.md`)
    expect(receipt.untrustedEvidence).toBe(true)

    const report = readFileSync(chatReportPath(s.agentRoot, RUN_ID), "utf8")
    expect(report.indexOf("## Host summary")).toBeLessThan(report.indexOf("## Agent context"))
    expect(report).toContain(BROADCAST_ITEM.text)
    expect(report).toContain("base-ai narrative is newly appended this run")
    expect(report).toContain("job: narrative-scan")
    expect(existsSync(join(layout.runs, RUN_ID, "chat-summary-receipt.json"))).toBe(true)
    expect(existsSync(join(layout.runs, RUN_ID, "chat-report.md"))).toBe(true)
  })

  it("promotes host-only summary when proposal is missing", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    const ingest = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
    })
    const receipt = await validateAndPromoteChatReport({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      ingest,
      facts: baseFacts("list-scan"),
    })
    expect(receipt.promoted).toBe(true)
    expect(receipt.hostOnly).toBe(true)
    expect(receipt.proposalAccepted).toBe(false)
    expect(receipt.proposalReason).toBe("proposal-missing")
    const report = readFileSync(chatReportPath(s.agentRoot, RUN_ID), "utf8")
    expect(report).toContain("## Host summary")
    expect(report).toContain(BROADCAST_ITEM.text)
    expect(report).not.toContain("## Agent context")
  })

  it("promotes zero-broadcast host summary", async () => {
    const s = scaffold(false)
    const layout = await ensureArchive(s.archiveRoot)
    writeProposal(s.agentRoot, validProposal([]))
    const receipt = await validateAndPromoteChatReport({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      ingest: { staged: 0, rejected: 0, rejects: [], items: [] },
      facts: buildHostChatFacts({
        job: "list-scan",
        runStatus: "complete",
        collection: { collectionStatus: "completed", postCount: 40 },
        engagementReport: {
          proposed: 2,
          accepted: 1,
          rejected: 1,
          executed: 1,
          verified: 1,
          ambiguous: 0,
        },
      }),
    })
    expect(receipt.promoted).toBe(true)
    expect(receipt.proposalAccepted).toBe(true)
    const report = readFileSync(chatReportPath(s.agentRoot, RUN_ID), "utf8")
    expect(report).toContain("staged: 0")
    expect(report).toContain("_none_")
    expect(report).toContain("### Engagement (x)")
    expect(report).toContain("base-ai narrative is newly appended this run")
  })

  it("renders FC degraded collection status without a proposal", async () => {
    const s = scaffold(false)
    const layout = await ensureArchive(s.archiveRoot)
    const receipt = await validateAndPromoteChatReport({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      ingest: { staged: 0, rejected: 0, rejects: [], items: [] },
      facts: buildHostChatFacts({
        job: "farcaster-scan",
        runStatus: "complete",
        collection: {
          collectionStatus: "analysis-only:following-ok",
          collectionKind: "external",
          postCount: 3,
          fypCasts: [],
        },
        platformNotes: [
          "collectionStatus=analysis-only:following-ok",
          "fallbackUsed=true",
          "usableEvidence=3",
          "engagementDisabled=true",
        ],
        fcEngagementReport: {
          proposed: 0,
          accepted: 0,
          rejected: 0,
          executed: 0,
          verified: 0,
          ambiguous: 0,
        },
      }),
    })
    expect(receipt.promoted).toBe(true)
    expect(receipt.hostOnly).toBe(true)
    expect(receipt.proposalReason).toBe("proposal-missing")
    const report = readFileSync(chatReportPath(s.agentRoot, RUN_ID), "utf8")
    expect(report).toContain("job: farcaster-scan")
    expect(report).toContain("analysis-only:following-ok")
    expect(report).toContain("fallbackUsed=true")
    expect(report).toContain("### Engagement (farcaster)")
  })

  it("keeps host summary when item ids mismatch", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    const ingest = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
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
      facts: baseFacts(),
    })
    expect(receipt.promoted).toBe(true)
    expect(receipt.proposalAccepted).toBe(false)
    expect(receipt.proposalReason).toBe("item-index-out-of-range")
    expect(receipt.itemIds).toEqual(stagedIds)
    const report = readFileSync(chatReportPath(s.agentRoot, RUN_ID), "utf8")
    expect(report).toContain("## Host summary")
    expect(report).not.toContain("## Agent context")
  })

  it("rejects source paths that escape the agent tree but still promotes host facts", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    const ingest = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
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
      facts: baseFacts(),
    })
    expect(receipt.promoted).toBe(true)
    expect(receipt.proposalReason).toBe("source-path-invalid")
    expect(existsSync(chatReportPath(s.agentRoot, RUN_ID))).toBe(true)
  })

  it("rejects symlinked source paths without suppressing host summary", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    const ingest = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
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
      facts: baseFacts(),
    })
    expect(receipt.promoted).toBe(true)
    expect(receipt.proposalReason).toBe("source-path-invalid")
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
    const report = readFileSync(chatReportPath(s.agentRoot, RUN_ID), "utf8")
    expect(report).not.toContain("secret")
  })

  it("drops oversize agent context and keeps host summary when possible", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    const ingest = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
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
      facts: baseFacts(),
      maxReportBytes: 500,
    })
    expect(receipt.promoted).toBe(true)
    expect(receipt.proposalReason).toBe("report-too-large")
    expect(receipt.hostOnly).toBe(true)
    const report = readFileSync(chatReportPath(s.agentRoot, RUN_ID), "utf8")
    expect(report).toContain("## Host summary")
    expect(report).not.toContain("## Agent context")
  })

  it("ignores direct agent bypass files and blocks canary promotion", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    const ingest = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
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
      facts: baseFacts(),
      blockPromotion: true,
    })
    expect(receipt.promoted).toBe(false)
    expect(receipt.reason).toBe("promotion-blocked")
    expect(existsSync(chatReportPath(s.agentRoot, RUN_ID))).toBe(false)
  })

  it("removes agent bypass files before promoting a host summary", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    const ingest = await ingestOutbox({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
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
      facts: baseFacts(),
    })
    expect(receipt.promoted).toBe(true)
    const report = readFileSync(chatReportPath(s.agentRoot, RUN_ID), "utf8")
    expect(report).not.toContain("agent bypass")
    expect(report).toContain(BROADCAST_ITEM.text)
  })
})

describe("promoteResearchChatReport", () => {
  it("promotes sanitized chat-summary body without host chrome", async () => {
    const {
      promoteResearchChatReport,
      sanitizeResearchChatBody,
    } = await import("../../src/orchestrator/chat-report.js")
    const dirty = [
      "# SOL research — chat summary",
      "",
      "SOL (So111…1112) · run discord-research-20260719125445 · 19 Jul 2026",
      "",
      "## Web context (untrusted)",
      "",
      "Token looks early but liquid enough to watch.",
      "",
    ].join("\n")
    expect(sanitizeResearchChatBody(dirty)).toBe([
      "# SOL research",
      "",
      "## Web context",
      "",
      "Token looks early but liquid enough to watch.",
      "",
    ].join("\n"))
    expect(sanitizeResearchChatBody(
      "Tone ok.\n\nBounded host search sample only; not platform-wide reach.\n",
    )).toBe("Tone ok.\n")

    const root = mkdtempSync(join(tmpdir(), "tc-research-chat-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "reports", RUN_ID), { recursive: true })
    writeFileSync(join(agentRoot, "reports", RUN_ID, "chat-summary.md"), dirty)
    const layout = await ensureArchive(archiveRoot)
    const result = await promoteResearchChatReport({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      subject: "solana:So11111111111111111111111111111111111111112",
      facts: buildHostChatFacts({
        job: "research",
        runStatus: "complete",
        researchDue: { subject: "solana:So11111111111111111111111111111111111111112" },
      }),
    })
    expect(result.promoted).toBe(true)
    expect(result.reportPath).toBe(`reports/chat/${RUN_ID}.md`)
    expect(result.hostOnly).toBe(false)
    const report = readFileSync(chatReportPath(agentRoot, RUN_ID), "utf8")
    expect(report).not.toContain("Chat recall")
    expect(report).not.toContain("Host summary")
    expect(report).not.toContain("Agent context")
    expect(report).not.toContain("chat summary")
    expect(report).not.toContain("untrusted")
    expect(report).not.toContain("· run ")
    expect(report).toContain("# SOL research")
    expect(report).toContain("Token looks early")
    expect(existsSync(join(layout.runs, RUN_ID, "research-chat-receipt.json"))).toBe(true)
  })

  it("promotes minimal subject stub when proposal is missing", async () => {
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
    expect(missing.promoted).toBe(true)
    expect(missing.hostOnly).toBe(true)
    expect(missing.proposalReason).toBe("proposal-missing")
    const stub = readFileSync(chatReportPath(agentRoot, RUN_ID), "utf8")
    expect(stub).toContain("Subject: solana:token")
    expect(stub).not.toContain("Host summary")

    writeFileSync(join(agentRoot, "reports", RUN_ID, "chat-summary.md"), "x".repeat(2_000))
    const oversize = await promoteResearchChatReport({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      subject: "solana:token",
      maxReportBytes: 100,
    })
    // Oversized proposal falls back to the short subject stub
    expect(oversize.promoted).toBe(true)
    expect(oversize.hostOnly).toBe(true)
    expect(oversize.proposalReason).toBe("proposal-too-large")
  })
})

describe("chat report retention", () => {
  it("age-prunes old chat reports while keeping recent ones", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-chat-retain-"))
    const chatDir = join(root, "reports", "chat")
    mkdirSync(chatDir, { recursive: true })
    const oldPath = join(chatDir, "old-run.md")
    const newPath = join(chatDir, "new-run.md")
    writeFileSync(oldPath, "old\n")
    writeFileSync(newPath, "new\n")
    const oldMs = Date.now() - 40 * 86_400_000
    const newMs = Date.now() - 1 * 86_400_000
    utimesSync(oldPath, oldMs / 1000, oldMs / 1000)
    utimesSync(newPath, newMs / 1000, newMs / 1000)
    const report = retainWorkspaceArtifacts({
      agentRoot: root,
      inboxMaxAgeDays: 30,
      chatReportsMaxAgeDays: 30,
    })
    expect(existsSync(oldPath)).toBe(false)
    expect(existsSync(newPath)).toBe(true)
    expect(report.chatReportsRemoved.length).toBe(1)
    expect(report.chatReportsRemoved[0]).toContain("old-run.md")
  })
})

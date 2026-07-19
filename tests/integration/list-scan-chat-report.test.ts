import { describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive } from "../../src/lib/archive.js"
import { ingestOutbox } from "../../src/orchestrator/outbox-ingest.js"
import {
  buildHostChatFacts,
  validateAndPromoteChatReport,
} from "../../src/orchestrator/chat-report.js"

const RUN_ID = "20260717T140000Z-listscan"
const NOW = "2026-07-17T14:00:00.000Z"

const LIST_SCAN_ITEM = {
  severity: "notable",
  text: "sentiment rotating into sol infra memes. still noisy.",
  refs: ["state/narratives/log.jsonl"],
  auditClaim: {
    type: "rotation",
    subject: "sol-infra-memes",
    direction: "rotation",
    horizonHours: 48,
    verificationRule: "rotation",
  },
}

describe("list-scan chat report promotion", () => {
  it("promotes chat-summary after a staged list-scan broadcast", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-list-chat-"))
    const agentRoot = join(root, "agent")
    const layout = await ensureArchive(join(root, "archive"))
    mkdirSync(join(agentRoot, "outbox"), { recursive: true })
    mkdirSync(join(agentRoot, "state", "narratives"), { recursive: true })
    mkdirSync(join(agentRoot, "reports", RUN_ID), { recursive: true })
    writeFileSync(join(agentRoot, "state", "narratives", "log.jsonl"), "{}\n")
    writeFileSync(
      join(agentRoot, "outbox", `${RUN_ID}.json`),
      `${JSON.stringify({ schema: 1, items: [LIST_SCAN_ITEM] }, null, 2)}\n`,
    )
    writeFileSync(
      join(agentRoot, "reports", RUN_ID, "chat-summary.json"),
      `${JSON.stringify({
        schema: 1,
        runId: RUN_ID,
        proposedAt: NOW,
        itemIds: ["item:0"],
        context: [
          "rotation claim is backed by FYP + list inbox paths",
          "operator should treat this as early sentiment not a call",
          "see state/narratives/log.jsonl for slug linkage",
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
    expect(ingest.staged).toBe(1)

    const receipt = await validateAndPromoteChatReport({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      ingest,
      facts: buildHostChatFacts({
        job: "list-scan",
        runStatus: "complete",
        collection: { collectionStatus: "completed", postCount: 20 },
      }),
    })
    expect(receipt.promoted).toBe(true)
    const reportPath = join(agentRoot, "reports", "chat", `${RUN_ID}.md`)
    expect(existsSync(reportPath)).toBe(true)
    expect(readFileSync(reportPath, "utf8")).toContain(LIST_SCAN_ITEM.text)
  })

  it("promotes host recall with zero staged broadcasts", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-list-chat-zero-"))
    const agentRoot = join(root, "agent")
    const layout = await ensureArchive(join(root, "archive"))
    mkdirSync(join(agentRoot, "reports", RUN_ID), { recursive: true })
    const receipt = await validateAndPromoteChatReport({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      ingest: { staged: 0, rejected: 0, rejects: [], items: [] },
      facts: buildHostChatFacts({
        job: "list-scan",
        runStatus: "complete",
        collection: { collectionStatus: "completed", postCount: 8 },
      }),
    })
    expect(receipt.promoted).toBe(true)
    expect(receipt.hostOnly).toBe(true)
    const report = readFileSync(join(agentRoot, "reports", "chat", `${RUN_ID}.md`), "utf8")
    expect(report).toContain("job: list-scan")
    expect(report).toContain("staged: 0")
  })
})

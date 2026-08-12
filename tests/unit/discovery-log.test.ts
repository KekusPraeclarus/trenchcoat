import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { archiveLayout, ensureArchive } from "../../src/lib/archive.js"
import {
  appendDiscoveryLog,
  appendQueueSweepDiscoveryLogs,
  discoveryLogPath,
} from "../../src/orchestrator/discovery-log.js"
import type { ResearchQueueEntry } from "../../src/contracts/schemas.js"

const NOW = "2026-07-23T12:00:00.000Z"
const TOKEN = "EN2nnxrg8uUi6x2sJkzNPd2eT6rB9rdSoQNNaENA4RZA"

function queueEntry(partial: Partial<ResearchQueueEntry> = {}): ResearchQueueEntry {
  return {
    schema: 1,
    queueId: "rq-test-1",
    subject: `solana:${TOKEN}`,
    chain: "solana",
    tokenAddress: TOKEN,
    resolution: "resolved",
    priority: 40,
    firstSeen: "2026-07-22T12:00:00.000Z",
    enqueuedAt: "2026-07-22T12:00:00.000Z",
    enqueuedBy: "test",
    trigger: "new-pools",
    expiresAt: "2026-07-22T18:00:00.000Z",
    provenance: ["feed:new-pools:gecko:solana:pool1"],
    clusterCount: 1,
    security: { status: "pass", flags: [] },
    status: "expired",
    reason: "expired",
    ...partial,
  }
}

describe("discovery-log", () => {
  it("appends typed rows under archive/discovery-log.jsonl", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-dlog-"))
    const layout = await ensureArchive(root)
    expect(discoveryLogPath(layout)).toBe(join(root, "discovery-log.jsonl"))

    await appendDiscoveryLog(layout, {
      schema: 1,
      recordId: "dl-test-1",
      recordedAt: NOW,
      runId: "list-scan-2026-07-23T12-00-00-000Z",
      trigger: "new-pools",
      chain: "solana",
      tokenAddress: TOKEN,
      reason: "candidate-accepted",
      source: "gecko-new-pools",
      securityStatus: "pass",
      surfacedAt: NOW,
    })

    const path = discoveryLogPath(layout)
    expect(existsSync(path)).toBe(true)
    const lines = readFileSync(path, "utf8").trim().split("\n")
    expect(lines).toHaveLength(1)
    const row = JSON.parse(lines[0]!) as { reason: string, trigger: string }
    expect(row.reason).toBe("candidate-accepted")
    expect(row.trigger).toBe("new-pools")
  })

  it("appends queue sweep rows for expired and security-fail", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-dlog-sweep-"))
    const layout = archiveLayout(root)
    await appendQueueSweepDiscoveryLogs(
      layout,
      [queueEntry()],
      "expired",
      NOW,
    )
    await appendQueueSweepDiscoveryLogs(
      layout,
      [queueEntry({
        queueId: "rq-test-2",
        status: "rejected",
        security: { status: "fail", flags: ["honeypot"] },
      })],
      "security-fail",
      NOW,
    )
    const lines = readFileSync(discoveryLogPath(layout), "utf8").trim().split("\n")
    expect(lines).toHaveLength(2)
    const reasons = lines.map((line) => (JSON.parse(line) as { reason: string }).reason)
    expect(reasons).toEqual(["expired", "security-fail"])
  })
})

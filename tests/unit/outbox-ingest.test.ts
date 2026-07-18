import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive } from "../../src/lib/archive.js"
import { Outbox } from "../../src/lib/outbox.js"
import { ingestOutbox } from "../../src/orchestrator/outbox-ingest.js"

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

async function scaffold(body: unknown) {
  const root = mkdtempSync(join(tmpdir(), "tc-ingest-"))
  const agentRoot = join(root, "agent")
  const archiveRoot = join(root, "archive")
  const layout = await ensureArchive(archiveRoot)
  mkdirSync(join(agentRoot, "outbox"), { recursive: true })
  writeFileSync(join(agentRoot, "outbox", `${RUN_ID}.json`), `${JSON.stringify(body, null, 2)}\n`)
  return { agentRoot, archiveRoot, layout }
}

describe("outbox ingest", () => {
  it("stages a valid item and reserves budget", async () => {
    const s = await scaffold({ schema: 1, items: [VALID_ITEM] })
    const report = await ingestOutbox({
      agentRoot: s.agentRoot, layout: s.layout, runId: RUN_ID,
      dailyBudget: 5, urgentCeiling: 10, nowIso: NOW,
    })
    expect(report.staged).toBe(1)
    expect(report.rejected).toBe(0)
    expect(new Outbox(join(s.layout.routerOutbox, RUN_ID)).list()).toHaveLength(1)
  })

  it("accepts a bare array of items", async () => {
    const s = await scaffold([VALID_ITEM])
    const report = await ingestOutbox({
      agentRoot: s.agentRoot, layout: s.layout, runId: RUN_ID,
      dailyBudget: 5, urgentCeiling: 10, nowIso: NOW,
    })
    expect(report.staged).toBe(1)
  })

  it("rejects an item whose direction contradicts its type", async () => {
    const bad = { ...VALID_ITEM, auditClaim: { ...VALID_ITEM.auditClaim, direction: "down" } }
    const s = await scaffold({ schema: 1, items: [bad] })
    const report = await ingestOutbox({
      agentRoot: s.agentRoot, layout: s.layout, runId: RUN_ID,
      dailyBudget: 5, urgentCeiling: 10, nowIso: NOW,
    })
    expect(report.staged).toBe(0)
    expect(report.rejected).toBe(1)
    expect(new Outbox(join(s.layout.routerOutbox, RUN_ID)).list()).toHaveLength(0)
    const rejects = JSON.parse(
      readFileSync(join(s.layout.runs, RUN_ID, "broadcast-rejects.json"), "utf8"),
    ) as { rejects: unknown[] }
    expect(rejects.rejects).toHaveLength(1)
  })

  it("rejects items once the budget is exhausted", async () => {
    const s = await scaffold({ schema: 1, items: [VALID_ITEM] })
    const report = await ingestOutbox({
      agentRoot: s.agentRoot, layout: s.layout, runId: RUN_ID,
      dailyBudget: 0, urgentCeiling: 10, nowIso: NOW,
    })
    expect(report.staged).toBe(0)
    expect(report.rejects[0]?.reason).toBe("budget:daily-budget")
  })

  it("returns an empty report when no outbox file exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-ingest-none-"))
    const layout = await ensureArchive(join(root, "archive"))
    const report = await ingestOutbox({
      agentRoot: join(root, "agent"), layout, runId: RUN_ID,
      dailyBudget: 5, urgentCeiling: 10, nowIso: NOW,
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
      agentRoot: s.agentRoot, layout: s.layout, runId: RUN_ID,
      dailyBudget: 5, urgentCeiling: 10, nowIso: NOW,
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
      agentRoot: s.agentRoot, layout: s.layout, runId: RUN_ID,
      dailyBudget: 5, urgentCeiling: 10, nowIso: NOW,
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
      dailyBudget: 5,
      urgentCeiling: 10,
      nowIso: NOW,
      marketBlind: true,
    })
    expect(report.staged).toBe(0)
    expect(report.rejected).toBe(1)
    expect(report.rejects[0]?.reason).toBe("market-blind:rotation-forbidden")
  })
})

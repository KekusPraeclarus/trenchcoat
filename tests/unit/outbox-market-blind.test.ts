import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive } from "../../src/lib/archive.js"
import { ingestOutbox } from "../../src/orchestrator/outbox-ingest.js"

const RUN_ID = "20260718T120000Z-narrativ"
const NOW = "2026-07-18T12:00:00.000Z"

const ROTATION_ITEM = {
  severity: "urgent",
  text: "capital rotating out of memes into ai agents on base rn",
  refs: ["state/narratives/log.jsonl"],
  auditClaim: {
    type: "rotation",
    subject: "base-ai",
    direction: "rotation",
    horizonHours: 72,
    verificationRule: "rotation",
  },
}

const EMERGENCE_ITEM = {
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

async function ingest(items: unknown[], marketBlind: boolean) {
  const root = mkdtempSync(join(tmpdir(), "tc-outbox-blind-"))
  const agentRoot = join(root, "agent")
  const layout = await ensureArchive(join(root, "archive"))
  mkdirSync(join(agentRoot, "outbox"), { recursive: true })
  writeFileSync(
    join(agentRoot, "outbox", `${RUN_ID}.json`),
    `${JSON.stringify({ schema: 1, items }, null, 2)}\n`,
  )
  return ingestOutbox({
    agentRoot,
    layout,
    runId: RUN_ID,
    dailyBudget: 5,
    urgentCeiling: 10,
    nowIso: NOW,
    marketBlind,
  })
}

describe("ingestOutbox market-blind rotation gate", () => {
  it("rejects a rotation broadcast when market-blind", async () => {
    const report = await ingest([ROTATION_ITEM], true)
    expect(report.staged).toBe(0)
    expect(report.rejects.some((r) => r.reason === "market-blind:rotation-forbidden")).toBe(true)
  })

  it("stages the same rotation broadcast when categories are present", async () => {
    const report = await ingest([ROTATION_ITEM], false)
    expect(report.staged).toBe(1)
    expect(report.items[0]?.auditClaim.type).toBe("rotation")
  })

  it("still stages a non-rotation emergence broadcast while market-blind", async () => {
    const report = await ingest([EMERGENCE_ITEM], true)
    expect(report.staged).toBe(1)
    expect(report.items[0]?.auditClaim.type).toBe("narrative-emergence")
  })
})

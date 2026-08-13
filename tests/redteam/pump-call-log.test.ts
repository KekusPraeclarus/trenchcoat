import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { archiveLayout } from "../../src/lib/archive.js"
import { appendSourceCallEventsFromArchiveInbox } from "../../src/orchestrator/call-log.js"

const MINT = "EN2nnxrg8uUi6x2sJkzNPd2eT6rB9rdSoQNNaENA4RZA"

describe("pump snapshots never become X source-calls", () => {
  it("ignores pump inbox text that carries a mint without bullish words", async () => {
    const root = mkdtempSync(join(tmpdir(), "pump-call-log-"))
    const layout = archiveLayout(root)
    const inbox = join(root, "runs", "pump-scan-1", "inbox")
    mkdirSync(inbox, { recursive: true })
    writeFileSync(join(inbox, "pump-fyp.json"), `${JSON.stringify({
      source: "host.pump-scan.pump-fyp",
      fetchedAt: "2026-08-13T12:00:00.000Z",
      trust: "untrusted-external",
      items: [{
        provenance: "pump-scan-1:pump:fyp:coin-1",
        text: `itemId=coin-1 author=alice.calls mint=${MINT} tab=fyp`,
        ts: "2026-08-13T12:00:00.000Z",
        ageSec: 0,
        freshnessTier: "live",
      }],
    }, null, 2)}\n`)
    const report = await appendSourceCallEventsFromArchiveInbox(layout, "pump-scan-1")
    expect(report.appended).toBe(0)
    expect(existsSync(join(layout.root, "source-call-log.jsonl"))).toBe(false)
  })
})

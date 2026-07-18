import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertAgentIntegrity, captureIntegritySnapshot } from "../../src/orchestrator/integrity.js"
import { validateAndPurgeAlphaDigest } from "../../src/orchestrator/alpha.js"
import { ensureArchive } from "../../src/lib/archive.js"
import { sha256Bytes } from "../../src/lib/fs-atomic.js"

const RUN_ID = "review-2026-07-18T12-00-00-000Z"
const NOW = "2026-07-18T12:10:00.000Z"

describe("review redteam confinement", () => {
  it("rejects hostile research paths that escape the agent tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-review-escape-"))
    const agentRoot = join(root, "agent")
    const recordBody = "# note\n"
    mkdirSync(join(agentRoot, "state", "research"), { recursive: true })
    writeFileSync(join(agentRoot, "state", "research", "safe.md"), recordBody)
    const messagePath = join(agentRoot, "alpha-queue", "alpha", "msg-1.json")
    mkdirSync(join(agentRoot, "alpha-queue", "alpha"), { recursive: true })
    const messageBody = `${JSON.stringify({ text: "alpha", provenance: "tg:1" })}\n`
    writeFileSync(messagePath, messageBody)

    const layout = await ensureArchive(join(root, "archive"))
    const digestDir = join(agentRoot, "reports", RUN_ID)
    mkdirSync(digestDir, { recursive: true })
    writeFileSync(join(digestDir, "alpha-digest.json"), `${JSON.stringify({
      schema: 1,
      runId: RUN_ID,
      proposedAt: NOW,
      entries: [{
        provenance: "tg:1",
        channel: "alpha",
        messageId: "msg-1",
        contentHash: sha256Bytes(messageBody),
        records: [{ path: "state/../../escaped.md", contentHash: sha256Bytes(recordBody) }],
      }],
    }, null, 2)}\n`)

    const receipt = await validateAndPurgeAlphaDigest({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
    })

    expect(receipt.rejected[0]?.reason).toBe("record-path-escapes-agent")
  })

  it("rejects direct host-state mutation from review artifacts", () => {
    const agentRoot = mkdtempSync(join(tmpdir(), "tc-review-host-state-"))
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    writeFileSync(join(agentRoot, "state", "watchlist.json"), JSON.stringify({
      schema: 1,
      entries: [],
    }))
    writeFileSync(join(agentRoot, "state", "INDEX.md"), "# INDEX\n")
    const before = captureIntegritySnapshot(agentRoot)

    writeFileSync(join(agentRoot, "state", "watchlist.json"), JSON.stringify({
      schema: 1,
      entries: [{ status: "tracking" }],
    }))
    writeFileSync(join(agentRoot, "state", "INDEX.md"), "# INDEX\n\nhacked\n")

    expect(() => assertAgentIntegrity(agentRoot, before)).toThrow(/watchlist\.json|INDEX\.md/u)
  })

  it("allows durable research distillations under state/research", () => {
    const agentRoot = mkdtempSync(join(tmpdir(), "tc-review-research-ok-"))
    mkdirSync(join(agentRoot, "state", "research"), { recursive: true })
    const before = captureIntegritySnapshot(agentRoot)
    writeFileSync(join(agentRoot, "state", "research", "SOL.md"), "# SOL\n")
    expect(() => assertAgentIntegrity(agentRoot, before)).not.toThrow()
  })
})

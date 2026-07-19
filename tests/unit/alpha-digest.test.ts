import { describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive } from "../../src/lib/archive.js"
import { sha256Bytes } from "../../src/lib/fs-atomic.js"
import { validateAndPurgeAlphaDigest } from "../../src/orchestrator/alpha.js"

const RUN_ID = "20260717T120000Z-ab12cd34"
const NOW = "2026-07-17T12:10:00.000Z"

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), "tc-alpha-"))
  const agentRoot = join(root, "agent")
  const archiveRoot = join(root, "archive")
  const recordBody = "# alpha note\nsomething useful\n"
  const messageBody = `${JSON.stringify({ text: "shill", provenance: "tg:alpha:msg:1" })}\n`

  const recordPath = join(agentRoot, "state", "research", "example.md")
  mkdirSync(join(agentRoot, "state", "research"), { recursive: true })
  writeFileSync(recordPath, recordBody)

  const messagePath = join(agentRoot, "alpha-queue", "alpha", "msg-1.json")
  mkdirSync(join(agentRoot, "alpha-queue", "alpha"), { recursive: true })
  writeFileSync(messagePath, messageBody)

  return {
    root,
    agentRoot,
    archiveRoot,
    messagePath,
    recordHash: sha256Bytes(recordBody),
    messageHash: sha256Bytes(messageBody),
  }
}

function writeDigest(agentRoot: string, entry: unknown) {
  const dir = join(agentRoot, "reports", RUN_ID)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "alpha-digest.json"), `${JSON.stringify({
    schema: 1,
    runId: RUN_ID,
    proposedAt: "2026-07-17T12:05:00.000Z",
    entries: [entry],
  }, null, 2)}\n`)
}

describe("alpha digest validate and purge", () => {
  it("purges the message when message and record hashes match", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    writeDigest(s.agentRoot, {
      provenance: "tg:alpha:msg:1",
      channel: "alpha",
      messageId: "msg-1",
      contentHash: s.messageHash,
      records: [{ path: "state/research/example.md", contentHash: s.recordHash }],
    })

    const receipt = await validateAndPurgeAlphaDigest({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
    })

    expect(receipt.accepted).toHaveLength(1)
    expect(receipt.rejected).toHaveLength(0)
    expect(receipt.purgedIds).toEqual(["msg-1"])
    expect(existsSync(s.messagePath)).toBe(false)
  })

  it("retains the message on a content-hash mismatch", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    writeDigest(s.agentRoot, {
      provenance: "tg:alpha:msg:1",
      channel: "alpha",
      messageId: "msg-1",
      contentHash: "sha256:" + "0".repeat(64),
      records: [{ path: "state/research/example.md", contentHash: s.recordHash }],
    })

    const receipt = await validateAndPurgeAlphaDigest({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
    })

    expect(receipt.accepted).toHaveLength(0)
    expect(receipt.rejected[0]).toMatchObject({ messageId: "msg-1", reason: "message-hash-mismatch" })
    expect(receipt.purgedIds).toHaveLength(0)
    expect(existsSync(s.messagePath)).toBe(true)
  })

  it("rejects a record path that escapes the agent tree and keeps the message", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    writeDigest(s.agentRoot, {
      provenance: "tg:alpha:msg:1",
      channel: "alpha",
      messageId: "msg-1",
      contentHash: s.messageHash,
      records: [{ path: "state/../../secret.md", contentHash: s.recordHash }],
    })

    const receipt = await validateAndPurgeAlphaDigest({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
    })

    expect(receipt.rejected[0]?.reason).toBe("record-path-escapes-agent")
    expect(existsSync(s.messagePath)).toBe(true)
  })

  it("fails closed with no deletes when the digest is missing", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    const receipt = await validateAndPurgeAlphaDigest({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
    })
    expect(receipt.accepted).toHaveLength(0)
    expect(receipt.purgedIds).toHaveLength(0)
    expect(receipt.invalidReason).toBeUndefined()
    expect(existsSync(s.messagePath)).toBe(true)
  })

  it("sets invalidReason=schema-invalid for narrative-shaped items digests", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    const dir = join(s.agentRoot, "reports", RUN_ID)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "alpha-digest.json"), `${JSON.stringify({
      schema: 1,
      runId: RUN_ID,
      proposedAt: "2026-07-17T12:05:00.000Z",
      items: [{
        slug: "rh-chain-meme-rotation",
        kind: "narrative",
        status: "peaking",
        summary: "wrong shape",
        provenanceIds: ["telegram:alpha"],
        confidence: 80,
      }],
    }, null, 2)}\n`)

    const receipt = await validateAndPurgeAlphaDigest({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
    })
    expect(receipt.invalidReason).toBe("schema-invalid")
    expect(receipt.accepted).toHaveLength(0)
    expect(receipt.purgedIds).toHaveLength(0)
    expect(existsSync(s.messagePath)).toBe(true)
  })

  it("sets invalidReason=run-id-mismatch when digest runId differs", async () => {
    const s = scaffold()
    const layout = await ensureArchive(s.archiveRoot)
    writeDigest(s.agentRoot, {
      provenance: "tg:alpha:msg:1",
      channel: "alpha",
      messageId: "msg-1",
      contentHash: s.messageHash,
      records: [{ path: "state/research/example.md", contentHash: s.recordHash }],
    })
    const digestPath = join(s.agentRoot, "reports", RUN_ID, "alpha-digest.json")
    const body = JSON.parse(readFileSync(digestPath, "utf8")) as { runId: string }
    body.runId = "20260717T999999Z-deadbeef"
    writeFileSync(digestPath, `${JSON.stringify(body, null, 2)}\n`)

    const receipt = await validateAndPurgeAlphaDigest({
      agentRoot: s.agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
    })
    expect(receipt.invalidReason).toBe("run-id-mismatch")
    expect(existsSync(s.messagePath)).toBe(true)
  })
})

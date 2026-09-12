import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  archiveLayout,
  broadcastBudgetPath,
  copyDirectoryManifest,
  ensureArchive,
  quarantineDir,
  runArchiveDir,
  transactionJournalPath,
  writeJsonRecordFsync,
} from "../../src/lib/archive.js"
import { writeAtomicFileFsync, sha256Bytes } from "../../src/lib/fs-atomic.js"
import { RunManifestSchema, AlphaDigestFileSchema, GateReceiptSchema } from "../../src/contracts/schemas.js"
import { GOLDEN_ALPHA_DIGEST, GOLDEN_RUN_ID } from "../../src/contracts/fixtures.js"
import { preArchiveRun } from "../../src/orchestrator/pre-archive.js"

describe("wave0 archive contracts", () => {
  it("exposes authoritative archive paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-archive-"))
    try {
      const layout = await ensureArchive(root)
      expect(transactionJournalPath(layout, GOLDEN_RUN_ID)).toBe(
        join(root, "transactions", `${GOLDEN_RUN_ID}.json`),
      )
      expect(runArchiveDir(layout, GOLDEN_RUN_ID)).toBe(join(root, "runs", GOLDEN_RUN_ID))
      expect(broadcastBudgetPath(layout, "2026-07-17")).toBe(
        join(root, "broadcast-budget", "2026-07-17.json"),
      )
      expect(layout.telegramDigests).toBe(join(root, "telegram-digests"))
      expect(quarantineDir(layout, GOLDEN_RUN_ID)).toBe(
        join(root, "quarantine", GOLDEN_RUN_ID),
      )
      expect(archiveLayout(root).exonerations).toBe(join(root, "exonerations"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("fsyncs journal-shaped records", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-fsync-"))
    try {
      const path = join(root, "transactions", `${GOLDEN_RUN_ID}.json`)
      const hash = await writeJsonRecordFsync(path, { schema: 1, runId: GOLDEN_RUN_ID })
      expect(hash.startsWith("sha256:")).toBe(true)
      const body = `${JSON.stringify({ schema: 1, runId: GOLDEN_RUN_ID }, null, 2)}\n`
      expect(hash).toBe(sha256Bytes(body))
      await writeAtomicFileFsync(join(root, "runs", "x.json"), "{}\n")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("parses frozen Wave 0 schemas", () => {
    expect(AlphaDigestFileSchema.parse(GOLDEN_ALPHA_DIGEST).runId).toBe(GOLDEN_RUN_ID)
    expect(RunManifestSchema.parse({
      schema: 1,
      runId: GOLDEN_RUN_ID,
      job: "list-scan",
      createdAt: "2026-07-17T12:00:00.000Z",
      inboxManifest: {},
      fileHashes: {},
    }).job).toBe("list-scan")
    expect(GateReceiptSchema.parse({
      schema: 1,
      receiptId: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      decisionId: "dec-1",
      chain: "solana",
      tokenAddress: "So11111111111111111111111111111111111111112",
      status: "pass",
      flags: [],
      source: "archived-dossier",
      evaluatedAt: "2026-07-17T12:00:00.000Z",
    }).status).toBe("pass")
  })

  it("copies nested inbox charts without EISDIR", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-archive-nested-"))
    try {
      const src = join(root, "inbox")
      const dest = join(root, "dest")
      mkdirSync(join(src, "charts"), { recursive: true })
      writeFileSync(join(src, "status.json"), "{}\n")
      writeFileSync(join(src, "charts", "token.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      const manifest = await copyDirectoryManifest(src, dest)
      expect(manifest["status.json"]).toMatch(/^sha256:/u)
      expect(manifest["charts/token.png"]).toMatch(/^sha256:/u)
      expect(existsSync(join(dest, "charts", "token.png"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("pre-archives nested chart PNGs", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-prearch-charts-"))
    try {
      const agentRoot = join(root, "agent")
      const archiveRoot = join(root, "archive")
      const layout = await ensureArchive(archiveRoot)
      mkdirSync(join(agentRoot, "inbox", GOLDEN_RUN_ID, "charts"), { recursive: true })
      writeFileSync(join(agentRoot, "inbox", GOLDEN_RUN_ID, "status.json"), "{}\n")
      writeFileSync(
        join(agentRoot, "inbox", GOLDEN_RUN_ID, "charts", "tok.png"),
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      )
      const result = await preArchiveRun({
        layout,
        agentRoot,
        runId: GOLDEN_RUN_ID,
        job: "chart-sweep",
        nowIso: "2026-07-17T12:00:00.000Z",
      })
      expect(result.manifest.inboxManifest["charts/tok.png"]).toMatch(/^sha256:/u)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

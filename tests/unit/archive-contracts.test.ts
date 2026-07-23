import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  archiveLayout,
  broadcastBudgetPath,
  ensureArchive,
  quarantineDir,
  runArchiveDir,
  transactionJournalPath,
  writeJsonRecordFsync,
} from "../../src/lib/archive.js"
import { writeAtomicFileFsync, sha256Bytes } from "../../src/lib/fs-atomic.js"
import { RunManifestSchema, AlphaDigestFileSchema, GateReceiptSchema } from "../../src/contracts/schemas.js"
import { GOLDEN_ALPHA_DIGEST, GOLDEN_RUN_ID } from "../../src/contracts/fixtures.js"

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
})

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { SNAPSHOT_MAX_ITEMS } from "../../src/contracts/schemas.js"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { writeListScanAlphaManifest } from "../../src/orchestrator/collect.js"
import { capManifestLines } from "../../src/orchestrator/review-collect.js"

describe("writeListScanAlphaManifest", () => {
  it("writes path-only pending alpha lines", async () => {
    const agentRoot = mkdtempSync(join(tmpdir(), "tc-list-scan-alpha-"))
    mkdirSync(join(agentRoot, "alpha-queue", "KashKyshAlpha"), { recursive: true })
    writeFileSync(
      join(agentRoot, "alpha-queue", "KashKyshAlpha", "42.json"),
      JSON.stringify({
        source: "telegram.preview",
        fetchedAt: "2026-07-19T00:00:00.000Z",
        trust: "untrusted-external",
        items: [{ provenance: "telegram:KashKyshAlpha", text: "secret body" }],
      }),
    )
    const runId = "list-scan-2026-07-19T00-00-00-000Z"
    const writer = new SnapshotWriter(agentRoot)
    const result = await writeListScanAlphaManifest({
      runId,
      writer,
      fetchedAt: "2026-07-19T00:00:00.000Z",
      agentRoot,
    })
    expect(result).toEqual({
      snapshotName: "list-scan-alpha-manifest",
      pendingCount: 1,
    })
    const body = readFileSync(
      join(agentRoot, "inbox", runId, "list-scan-alpha-manifest.json"),
      "utf8",
    )
    expect(body).toContain("path=alpha-queue/KashKyshAlpha/42.json")
    expect(body).not.toContain("secret body")
  })

  it("writes pendingAlpha=(none) when the queue is empty", async () => {
    const agentRoot = mkdtempSync(join(tmpdir(), "tc-list-scan-alpha-empty-"))
    const runId = "list-scan-empty"
    const writer = new SnapshotWriter(agentRoot)
    const result = await writeListScanAlphaManifest({
      runId,
      writer,
      fetchedAt: "2026-07-19T00:00:00.000Z",
      agentRoot,
    })
    expect(result.pendingCount).toBe(0)
    const body = readFileSync(
      join(agentRoot, "inbox", runId, "list-scan-alpha-manifest.json"),
      "utf8",
    )
    expect(body).toContain("pendingAlpha=(none)")
  })

  it("caps overflow queues to SNAPSHOT_MAX_ITEMS with truncated marker", async () => {
    const agentRoot = mkdtempSync(join(tmpdir(), "tc-list-scan-alpha-cap-"))
    const channelDir = join(agentRoot, "alpha-queue", "overflow")
    mkdirSync(channelDir, { recursive: true })
    const total = SNAPSHOT_MAX_ITEMS + 16
    for (let i = 0; i < total; i += 1) {
      writeFileSync(
        join(channelDir, `${String(i).padStart(4, "0")}.json`),
        JSON.stringify({
          source: "telegram.preview",
          fetchedAt: "2026-07-19T00:00:00.000Z",
          trust: "untrusted-external",
          items: [{ provenance: "telegram:overflow", text: "x" }],
        }),
      )
    }
    const runId = "list-scan-overflow"
    const writer = new SnapshotWriter(agentRoot)
    const result = await writeListScanAlphaManifest({
      runId,
      writer,
      fetchedAt: "2026-07-19T00:00:00.000Z",
      agentRoot,
    })
    expect(result.pendingCount).toBe(total)
    const envelope = JSON.parse(
      readFileSync(join(agentRoot, "inbox", runId, "list-scan-alpha-manifest.json"), "utf8"),
    ) as { items: ReadonlyArray<{ text: string }> }
    expect(envelope.items).toHaveLength(SNAPSHOT_MAX_ITEMS)
    expect(envelope.items.at(-1)?.text).toBe(`truncated=${total - (SNAPSHOT_MAX_ITEMS - 1)}`)
  })
})

describe("capManifestLines", () => {
  it("keeps short lists intact", () => {
    expect(capManifestLines(["a", "b"])).toEqual(["a", "b"])
  })

  it("reserves the last slot for truncated=", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `path=${i}`)
    expect(capManifestLines(lines, 10)).toEqual([
      ...lines.slice(0, 9),
      "truncated=3",
    ])
  })
})

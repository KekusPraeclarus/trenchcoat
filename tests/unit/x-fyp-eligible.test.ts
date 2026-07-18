import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import {
  loadXFypEligibleManifest,
  manifestFromEnvelope,
  writeXFypEligibleSnapshot,
} from "../../src/orchestrator/x-fyp-eligible.js"

describe("x-fyp-eligible manifest", () => {
  it("round-trips host-derived FYP posts through inbox snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-fyp-"))
    const writer = new SnapshotWriter(root)
    const runId = "list-scan-2026-07-18T120000Z"
    const fetchedAt = "2026-07-18T12:00:00.000Z"
    const posts = [
      { id: "1234567890", author: "alpha" },
      { id: "9876543210", author: "beta" },
    ]

    await writeXFypEligibleSnapshot({ writer, runId, fetchedAt, posts })

    const loaded = loadXFypEligibleManifest(root, join(root, "archive"), runId)
    expect(loaded).toEqual({
      schema: 1,
      runId,
      collectedAt: fetchedAt,
      posts: [
        { postId: "1234567890", author: "alpha" },
        { postId: "9876543210", author: "beta" },
      ],
    })
  })

  it("loads sealed archive copy when live inbox is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-fyp-archive-"))
    const archiveRoot = join(root, "archive")
    const runId = "list-scan-archived"
    const fetchedAt = "2026-07-18T12:00:00.000Z"
    const inboxDir = join(archiveRoot, "runs", runId, "inbox")
    mkdirSync(inboxDir, { recursive: true })
    writeFileSync(join(inboxDir, "x-fyp-eligible.json"), `${JSON.stringify({
      source: "host.x-fyp-eligible",
      fetchedAt,
      trust: "untrusted-external",
      items: [{
        provenance: `${runId}:x-fyp-eligible:1111111111`,
        text: "postId=1111111111 author=gamma",
        ts: fetchedAt,
        ageSec: 0,
        freshnessTier: "live",
        dedupeKey: "1111111111",
      }],
    }, null, 2)}\n`)

    const loaded = loadXFypEligibleManifest(join(root, "agent"), archiveRoot, runId)
    expect(loaded?.posts).toEqual([{ postId: "1111111111", author: "gamma" }])
  })

  it("manifestFromEnvelope rejects malformed item text", () => {
    expect(() => manifestFromEnvelope({
      source: "host.x-fyp-eligible",
      fetchedAt: "2026-07-18T12:00:00.000Z",
      trust: "untrusted-external",
      items: [{
        provenance: "run:x-fyp-eligible:1",
        text: "not-a-manifest-line",
        ts: "2026-07-18T12:00:00.000Z",
        ageSec: 0,
        freshnessTier: "live",
      }],
    })).toThrow()
  })
})

import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  FcSourceSeedFileSchema,
  normalizeFcSourceSeedEntries,
  parseFcSourceSeedFile,
  seedFcSourceLifecycle,
} from "../../src/sources/fc-seed.js"
import { applyFcSourceSeed } from "../../src/orchestrator/fc-source-seed.js"
import { StateStore } from "../../src/lib/state.js"

const EMPTY_FC_LIFECYCLE = {
  schema: 1 as const,
  candidates: [],
  transitions: [],
  pendingTransitionIds: [],
}

describe("fc source seed", () => {
  it("validates positive fids and normalized handles", () => {
    const seed = FcSourceSeedFileSchema.parse({
      schema: 1,
      sources: [
        { handle: "@Alice", fid: 42, status: "managed" },
        { handle: "bob", fid: 43, status: "probation" },
      ],
    })
    const normalized = normalizeFcSourceSeedEntries(seed.sources)
    expect(normalized.map((e) => e.handle)).toEqual(["alice", "bob"])
  })

  it("throws on conflicting handles for the same fid", () => {
    expect(() => normalizeFcSourceSeedEntries([
      { handle: "bob", fid: 10, status: "managed" },
      { handle: "alice2", fid: 10, status: "managed" },
    ])).toThrow(/Conflicting handles/i)
  })

  it("rejects forbidden signer or inbox fields", () => {
    expect(() => parseFcSourceSeedFile({
      schema: 1,
      signerUuid: "evil",
      sources: [{ handle: "alice", fid: 1 }],
    })).toThrow(/Forbidden seed field/i)
  })

  it("is idempotent on repeat apply", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-fc-seed-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    const store = new StateStore(join(agentRoot, "state"))
    await store.saveFcSourceLifecycle(EMPTY_FC_LIFECYCLE)
    const seedPath = join(root, "fc-seed.json")
    const { writeFileSync } = await import("node:fs")
    writeFileSync(seedPath, `${JSON.stringify({
      schema: 1,
      sources: [{ handle: "alice", fid: 10, status: "managed" }],
    }, null, 2)}\n`)

    const first = await applyFcSourceSeed({
      agentRoot,
      archiveRoot,
      seedPath,
      runId: "fc-seed-1",
      nowIso: "2026-07-18T00:00:00.000Z",
    })
    const second = await applyFcSourceSeed({
      agentRoot,
      archiveRoot,
      seedPath,
      runId: "fc-seed-2",
      nowIso: "2026-07-18T01:00:00.000Z",
    })
    expect(first.added).toBe(1)
    expect(second.added).toBe(0)
    expect(second.skipped).toBe(1)
    expect(store.loadFcSourceLifecycle().candidates).toHaveLength(1)
    expect(store.loadSources().sources.some((s) => s.sourceId === "fc_alice")).toBe(true)
    const receipt = JSON.parse(readFileSync(second.receiptPath, "utf8")) as { transitions: unknown[] }
    expect(receipt.transitions).toHaveLength(0)
  })

  it("dry-run writes receipt without mutating lifecycle", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-fc-seed-dry-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    const store = new StateStore(join(agentRoot, "state"))
    await store.saveFcSourceLifecycle(EMPTY_FC_LIFECYCLE)
    const seedPath = join(root, "fc-seed.json")
    const { writeFileSync } = await import("node:fs")
    writeFileSync(seedPath, `${JSON.stringify({
      schema: 1,
      sources: [{ handle: "alice", fid: 10, status: "managed" }],
    }, null, 2)}\n`)

    const report = await applyFcSourceSeed({
      agentRoot,
      archiveRoot,
      seedPath,
      dryRun: true,
    })
    expect(report.dryRun).toBe(true)
    expect(store.loadFcSourceLifecycle().candidates).toHaveLength(0)
    const seeded = seedFcSourceLifecycle({
      entries: [{ handle: "alice", fid: 10, status: "managed" }],
      existing: EMPTY_FC_LIFECYCLE,
      nowIso: "2026-07-18T00:00:00.000Z",
      runId: "dry",
    })
    expect(seeded.added).toBe(1)
  })
})

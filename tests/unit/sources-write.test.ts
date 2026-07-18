import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../../src/lib/state.js"
import { SourceWriter, NEUTRAL_SOURCE_SCORE } from "../../src/orchestrator/sources-write.js"

function freshWriter(): { store: StateStore; writer: SourceWriter } {
  const root = mkdtempSync(join(tmpdir(), "tc-sources-write-"))
  const store = new StateStore(join(root, "agent", "state"))
  return { store, writer: new SourceWriter(store) }
}

const NEUTRAL = { sourceId: "x_alpha", handle: "alpha", platform: "x" } as const

describe("SourceWriter host-only guard", () => {
  it("refuses a sources path outside a state dir", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-sw-nostate-"))
    const store = new StateStore(join(root, "agent", "notstate"))
    expect(() => new SourceWriter(store)).toThrow(/non-state/u)
  })

  it("refuses an agent-authored sources path", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-sw-inbox-"))
    const store = new StateStore(join(root, "agent", "inbox", "state"))
    expect(() => new SourceWriter(store)).toThrow(/agent-authored/u)
  })
})

describe("upsertNeutralSource", () => {
  it("registers a neutral undocked source", async () => {
    const { store, writer } = freshWriter()
    await writer.upsertNeutralSource(NEUTRAL)
    const record = store.loadSources().sources[0]
    expect(record).toMatchObject({
      sourceId: "x_alpha",
      score: NEUTRAL_SOURCE_SCORE,
      docked: false,
      rugAdjacency: 0,
    })
  })

  it("never overwrites an existing record", async () => {
    const { store, writer } = freshWriter()
    await writer.upsertNeutralSource(NEUTRAL)
    await writer.applyLaggedScore({ sourceId: "x_alpha", score: 0.9, scoreUpdatedAt: "2026-07-17T00:00:00.000Z" })
    await writer.upsertNeutralSource(NEUTRAL)
    const record = store.loadSources().sources[0]
    expect(record?.score).toBe(0.9)
    expect(store.loadSources().sources).toHaveLength(1)
  })
})

describe("applyLaggedScore", () => {
  it("updates score and clamps to [0,1]", async () => {
    const { store, writer } = freshWriter()
    await writer.upsertNeutralSource(NEUTRAL)
    await writer.applyLaggedScore({ sourceId: "x_alpha", score: 5, scoreUpdatedAt: "2026-07-17T00:00:00.000Z" })
    expect(store.loadSources().sources[0]?.score).toBe(1)
  })

  it("throws for an unknown source", async () => {
    const { writer } = freshWriter()
    await expect(writer.applyLaggedScore({
      sourceId: "x_ghost",
      score: 0.5,
      scoreUpdatedAt: "2026-07-17T00:00:00.000Z",
    })).rejects.toThrow(/unknown source/u)
  })
})

describe("setDocked / clearDock", () => {
  it("docks and increments adjacency once, idempotent on the flip", async () => {
    const { store, writer } = freshWriter()
    await writer.upsertNeutralSource(NEUTRAL)
    await writer.setDocked({ sourceId: "x_alpha", dockReason: "rug-shill:honeypot", incrementRugAdjacency: true })
    await writer.setDocked({ sourceId: "x_alpha", dockReason: "rug-shill:honeypot", incrementRugAdjacency: true })
    const record = store.loadSources().sources[0]
    expect(record?.docked).toBe(true)
    expect(record?.dockReason).toBe("rug-shill:honeypot")
    expect(record?.rugAdjacency).toBe(1)
  })

  it("leaves score untouched when docking", async () => {
    const { store, writer } = freshWriter()
    await writer.upsertNeutralSource(NEUTRAL)
    await writer.setDocked({ sourceId: "x_alpha", dockReason: "x" })
    expect(store.loadSources().sources[0]?.score).toBe(NEUTRAL_SOURCE_SCORE)
    expect(store.loadSources().sources[0]?.rugAdjacency).toBe(0)
  })

  it("clears the dock and drops the reason, idempotently", async () => {
    const { store, writer } = freshWriter()
    await writer.upsertNeutralSource(NEUTRAL)
    await writer.setDocked({ sourceId: "x_alpha", dockReason: "x", incrementRugAdjacency: true })
    await writer.clearDock("x_alpha")
    await writer.clearDock("x_alpha")
    const record = store.loadSources().sources[0]
    expect(record?.docked).toBe(false)
    expect(record?.dockReason).toBeUndefined()
    expect(record?.rugAdjacency).toBe(1)
  })
})

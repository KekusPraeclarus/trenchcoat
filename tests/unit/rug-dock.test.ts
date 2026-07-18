import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../../src/lib/state.js"
import { archiveLayout } from "../../src/lib/archive.js"
import { registerDiscoveryCandidates } from "../../src/sources/lifecycle.js"
import { loadExonerations } from "../../src/orchestrator/exoneration.js"
import {
  runRugDock,
  attributeRugDock,
  provenanceToSource,
  type RugDockIdentity,
} from "../../src/orchestrator/rug-dock.js"
import type { SnapshotEnvelope } from "../../src/contracts/schemas.js"

const CA = "So11111111111111111111111111111111111111112"
const NOW = "2026-07-17T12:00:00.000Z"
const RESOLVED: RugDockIdentity = { tokenAddress: CA, resolution: "resolved" }

function snapshot(items: readonly { provenance: string; text: string; ts: string }[]): SnapshotEnvelope {
  return {
    source: "list-scan",
    fetchedAt: NOW,
    trust: "untrusted-external",
    items: items.map((i) => ({ ...i, ageSec: 0, freshnessTier: "stale" as const })),
  }
}

async function freshStore(): Promise<{ store: StateStore; layout: ReturnType<typeof archiveLayout> }> {
  const root = mkdtempSync(join(tmpdir(), "tc-rugdock-"))
  return { store: new StateStore(join(root, "agent", "state")), layout: archiveLayout(join(root, "archive")) }
}

describe("provenanceToSource", () => {
  it("maps known platforms deterministically", () => {
    expect(provenanceToSource("twitter:@Shiller")).toMatchObject({ sourceId: "x_shiller", platform: "x" })
    expect(provenanceToSource("telegram:scamchan")).toMatchObject({ sourceId: "tg_scamchan", platform: "telegram" })
    expect(provenanceToSource("farcaster:@caster")).toMatchObject({ sourceId: "fc_caster", platform: "farcaster" })
    expect(provenanceToSource("discord:nope")).toBeUndefined()
  })
})

describe("attributeRugDock", () => {
  it("links a source only when a raw CA appears within the lookback window", () => {
    const snaps = [snapshot([
      { provenance: "twitter:@shiller", text: `aped ${CA} lfg`, ts: "2026-07-15T12:00:00.000Z" },
      { provenance: "twitter:@stale", text: `old call ${CA}`, ts: "2026-06-01T12:00:00.000Z" },
      { provenance: "twitter:@clean", text: "no address here", ts: "2026-07-16T12:00:00.000Z" },
    ])]
    const out = attributeRugDock({ identity: RESOLVED, snapshots: snaps, nowIso: NOW, lookbackDays: 7 })
    expect(out).toHaveLength(1)
    expect(out[0]?.sourceId).toBe("x_shiller")
  })

  it("dedupes identical messages", () => {
    const item = { provenance: "twitter:@shiller", text: `aped ${CA}`, ts: "2026-07-15T12:00:00.000Z" }
    const out = attributeRugDock({ identity: RESOLVED, snapshots: [snapshot([item, item])], nowIso: NOW, lookbackDays: 7 })
    expect(out).toHaveLength(1)
  })

  it("excludes model-confirmed identities (INV-S16)", () => {
    const snaps = [snapshot([{ provenance: "twitter:@shiller", text: `aped ${CA}`, ts: "2026-07-15T12:00:00.000Z" }])]
    const out = attributeRugDock({
      identity: { tokenAddress: CA, resolution: "model-confirmed" },
      snapshots: snaps,
      nowIso: NOW,
      lookbackDays: 7,
    })
    expect(out).toHaveLength(0)
  })
})

describe("runRugDock", () => {
  const snaps = [snapshot([{ provenance: "twitter:@shiller", text: `buy ${CA} now`, ts: "2026-07-15T12:00:00.000Z" }])]

  it("no-ops without a scanner hard-fail", async () => {
    const { store, layout } = await freshStore()
    const report = await runRugDock({
      store, layout, identity: RESOLVED, scannerFlags: [], snapshots: snaps,
      nowIso: NOW, lookbackDays: 7, dailyCap: 20, usedToday: 0,
    })
    expect(report.attributions).toBe(0)
    expect(store.loadSources().sources).toHaveLength(0)
  })

  it("hard docks a shill and hard-docks the lifecycle candidate", async () => {
    const { store, layout } = await freshStore()
    await store.saveSourceLifecycle(registerDiscoveryCandidates(
      store.loadSourceLifecycle(),
      [{ handle: "shiller", origin: "fyp" }],
      "2026-07-10T12:00:00.000Z",
    ))
    const report = await runRugDock({
      store, layout, identity: RESOLVED, scannerFlags: ["honeypot"], snapshots: snaps,
      nowIso: NOW, lookbackDays: 7, dailyCap: 20, usedToday: 0,
      runSession: async () => "shill",
    })
    expect(report.docked).toBe(1)
    expect(report.warned).toBe(0)
    const record = store.loadSources().sources[0]
    expect(record?.docked).toBe(true)
    expect(record?.rugAdjacency).toBe(1)
    expect(store.loadSourceLifecycle().candidates[0]?.hardDocked).toBe(true)
    expect(loadExonerations(layout).proposals).toHaveLength(0)
  })

  it("routes a warn to an exoneration proposal instead of a permanent dock", async () => {
    const { store, layout } = await freshStore()
    const report = await runRugDock({
      store, layout, identity: RESOLVED, scannerFlags: ["honeypot"], snapshots: snaps,
      nowIso: NOW, lookbackDays: 7, dailyCap: 20, usedToday: 0,
      runSession: async () => "warn",
    })
    expect(report.warned).toBe(1)
    expect(report.docked).toBe(0)
    const proposals = loadExonerations(layout).proposals
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.status).toBe("pending")
    expect(store.loadSources().sources[0]?.rugAdjacency).toBe(1)
  })

  it("fails closed to a dock when the classifier cap is exhausted", async () => {
    const { store, layout } = await freshStore()
    const report = await runRugDock({
      store, layout, identity: RESOLVED, scannerFlags: ["honeypot"], snapshots: snaps,
      nowIso: NOW, lookbackDays: 7, dailyCap: 1, usedToday: 1,
      runSession: async () => "warn",
    })
    expect(report.capExhausted).toBe(1)
    expect(report.docked).toBe(1)
    expect(report.warned).toBe(0)
    expect(store.loadSources().sources[0]?.docked).toBe(true)
  })

  it("skips model-confirmed identities entirely", async () => {
    const { store, layout } = await freshStore()
    const report = await runRugDock({
      store, layout, identity: { tokenAddress: CA, resolution: "model-confirmed" },
      scannerFlags: ["honeypot"], snapshots: snaps,
      nowIso: NOW, lookbackDays: 7, dailyCap: 20, usedToday: 0,
      runSession: async () => "shill",
    })
    expect(report.skippedModelConfirmed).toBe(true)
    expect(report.attributions).toBe(0)
    expect(store.loadSources().sources).toHaveLength(0)
  })
})

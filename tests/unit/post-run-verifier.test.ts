import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive, runArchiveDir, type ArchiveLayout } from "../../src/lib/archive.js"
import { runPostRunVerifier } from "../../src/orchestrator/verify.js"
import type {
  GateReceipt,
  MarketQualityReceipt,
  RunManifest,
  SnapshotEnvelope,
  ValidationReceipt,
} from "../../src/contracts/schemas.js"
import type { PostRunVerifierInput } from "../../src/contracts/interfaces.js"

const RUN_ID = "list-scan-2026-07-17T00-00-00-000Z"
const NOW = "2026-07-17T00:00:00.000Z"
const TOKEN = "So11111111111111111111111111111111111111112"
const PAIR = "pair1111111111111111111111111111111111111111"
const GATE_ID = `sha256:${"b".repeat(64)}` as const
const MQ_ID = `sha256:${"c".repeat(64)}` as const
const RECEIPT_ID = `sha256:${"a".repeat(64)}` as const
const HASH_A = `sha256:${"1".repeat(64)}` as const
const HASH_B = `sha256:${"2".repeat(64)}` as const

function seedInbox(layout: ArchiveLayout, provenance = "x:alpha:1"): void {
  const inboxDir = join(runArchiveDir(layout, RUN_ID), "inbox")
  mkdirSync(inboxDir, { recursive: true })
  const envelope: SnapshotEnvelope = {
    source: "x-list",
    fetchedAt: NOW,
    trust: "untrusted-external",
    items: [{ provenance, text: "gm", ts: NOW, ageSec: 10, freshnessTier: "live" }],
  }
  writeFileSync(join(inboxDir, "snap.json"), JSON.stringify(envelope))
}

function seedManifest(layout: ArchiveLayout, runId = RUN_ID): void {
  const manifest: RunManifest = {
    schema: 1,
    runId,
    job: "list-scan",
    createdAt: NOW,
    inboxManifest: {},
    fileHashes: {},
  }
  writeFileSync(join(runArchiveDir(layout, RUN_ID), "manifest.json"), JSON.stringify(manifest))
}

function acceptedReceipt(overrides: Partial<ValidationReceipt> = {}): ValidationReceipt {
  return {
    schema: 1,
    receiptId: RECEIPT_ID,
    proposalId: "prop-1",
    runId: RUN_ID,
    accepted: true,
    appliedDecisionId: "dec-1",
    blockedExternalEffects: [],
    provenanceIds: ["x:alpha:1"],
    gateReceiptId: GATE_ID,
    decidedAt: NOW,
    policyVersion: "policy-1",
    assignment: "baseline",
    ...overrides,
  }
}

function passGate(overrides: Partial<GateReceipt> = {}): GateReceipt {
  return {
    schema: 1,
    receiptId: GATE_ID,
    decisionId: "dec-1",
    chain: "solana",
    tokenAddress: TOKEN,
    status: "pass",
    flags: [],
    source: "archived-dossier",
    evaluatedAt: NOW,
    ...overrides,
  }
}

function mqReceipt(overrides: Partial<MarketQualityReceipt> = {}): MarketQualityReceipt {
  return {
    schema: 1,
    receiptId: MQ_ID,
    decisionId: "dec-1",
    chain: "solana",
    tokenAddress: TOKEN,
    pairAddress: PAIR,
    status: "pass",
    reasons: [],
    source: "archived-dossier",
    evaluatedAt: NOW,
    ...overrides,
  }
}

function baseInput(layout: ArchiveLayout, overrides: Partial<PostRunVerifierInput> = {}): PostRunVerifierInput {
  return {
    layout,
    agentRoot: layout.root,
    runId: RUN_ID,
    beforeWatchlistHash: HASH_A,
    afterWatchlistHash: HASH_B,
    receipts: [acceptedReceipt()],
    gateReceipts: [passGate()],
    marketQualityReceipts: [],
    nowIso: NOW,
    ...overrides,
  }
}

async function setup(): Promise<ArchiveLayout> {
  const root = mkdtempSync(join(tmpdir(), "tc-verify-"))
  const layout = await ensureArchive(join(root, "archive"))
  mkdirSync(runArchiveDir(layout, RUN_ID), { recursive: true })
  return layout
}

describe("post-run verifier", () => {
  it("passes the golden case with matching evidence", async () => {
    const layout = await setup()
    seedInbox(layout)
    seedManifest(layout)

    const report = await runPostRunVerifier(baseInput(layout))
    expect(report.passed).toBe(true)
    expect(report.checks.map((c) => c.id)).toEqual(["S1", "S3", "S5", "S6", "S9", "S23"])
    expect(report.checks.every((c) => c.passed)).toBe(true)
  })

  it("S1 fails when the watchlist changes without an accepted receipt", async () => {
    const layout = await setup()
    seedInbox(layout)
    seedManifest(layout)

    const report = await runPostRunVerifier(baseInput(layout, { receipts: [], gateReceipts: [] }))
    expect(report.passed).toBe(false)
    expect(report.checks.find((c) => c.id === "S1")?.passed).toBe(false)
  })

  it("S3 fails closed when the archived inbox or manifest is missing", async () => {
    const layout = await setup()
    // no inbox, no manifest
    const report = await runPostRunVerifier(baseInput(layout))
    expect(report.checks.find((c) => c.id === "S3")?.passed).toBe(false)
  })

  it("S5 fails when an integrity incident is flagged", async () => {
    const layout = await setup()
    seedInbox(layout)
    seedManifest(layout)
    writeFileSync(
      join(runArchiveDir(layout, RUN_ID), "incidents.json"),
      JSON.stringify([{ kind: "integrity", message: "tamper" }]),
    )
    const report = await runPostRunVerifier(baseInput(layout))
    expect(report.checks.find((c) => c.id === "S5")?.passed).toBe(false)
  })

  it("S6 fails when a receipt cites provenance outside the archived inbox", async () => {
    const layout = await setup()
    seedInbox(layout, "x:trusted:1")
    seedManifest(layout)
    const report = await runPostRunVerifier(baseInput(layout))
    expect(report.checks.find((c) => c.id === "S6")?.passed).toBe(false)
  })

  it("S9 fails when new tracking references a non-passing gate", async () => {
    const layout = await setup()
    seedInbox(layout)
    seedManifest(layout)
    const report = await runPostRunVerifier(baseInput(layout, {
      gateReceipts: [passGate({ status: "hard-fail" })],
    }))
    expect(report.checks.find((c) => c.id === "S9")?.passed).toBe(false)
  })

  it("S9 requires market-quality pass for applied tracking", async () => {
    const layout = await setup()
    seedInbox(layout)
    seedManifest(layout)
    const report = await runPostRunVerifier(baseInput(layout, {
      receipts: [acceptedReceipt({
        appliedWatchlistStatus: "tracking",
        marketQualityReceiptId: MQ_ID,
      })],
      marketQualityReceipts: [mqReceipt({ status: "fail", reasons: ["liquidity"] })],
    }))
    expect(report.checks.find((c) => c.id === "S9")?.passed).toBe(false)
  })

  it("S9 requires market-quality fail for applied watching", async () => {
    const layout = await setup()
    seedInbox(layout)
    seedManifest(layout)
    const passReport = await runPostRunVerifier(baseInput(layout, {
      receipts: [acceptedReceipt({
        appliedWatchlistStatus: "watching",
        marketQualityReceiptId: MQ_ID,
      })],
      marketQualityReceipts: [mqReceipt({ status: "fail", reasons: ["liquidity"] })],
    }))
    expect(passReport.checks.find((c) => c.id === "S9")?.passed).toBe(true)

    const failReport = await runPostRunVerifier(baseInput(layout, {
      receipts: [acceptedReceipt({
        appliedWatchlistStatus: "watching",
        marketQualityReceiptId: MQ_ID,
      })],
      marketQualityReceipts: [mqReceipt({ status: "pass" })],
    }))
    expect(failReport.checks.find((c) => c.id === "S9")?.passed).toBe(false)
  })

  it("S23 fails when a delta is not backed by an applied receipt", async () => {
    const layout = await setup()
    seedInbox(layout)
    seedManifest(layout)
    const report = await runPostRunVerifier(baseInput(layout, {
      receipts: [acceptedReceipt({ appliedDecisionId: undefined, gateReceiptId: undefined })],
      gateReceipts: [],
    }))
    expect(report.checks.find((c) => c.id === "S1")?.passed).toBe(true)
    expect(report.checks.find((c) => c.id === "S23")?.passed).toBe(false)
  })

  it("passes with no delta and no receipts", async () => {
    const layout = await setup()
    seedInbox(layout)
    seedManifest(layout)
    const report = await runPostRunVerifier(baseInput(layout, {
      beforeWatchlistHash: HASH_A,
      afterWatchlistHash: HASH_A,
      receipts: [],
      gateReceipts: [],
    }))
    expect(report.passed).toBe(true)
  })
})

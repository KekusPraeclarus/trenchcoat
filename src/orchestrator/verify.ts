import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { runArchiveDir, type ArchiveLayout } from "../lib/archive.js"
import {
  PostRunVerifierReportSchema,
  RunManifestSchema,
  SnapshotEnvelopeSchema,
  type GateReceipt,
  type MarketQualityReceipt,
  type PostRunVerifierReport,
  type ValidationReceipt,
} from "../contracts/schemas.js"
import type { PostRunVerifier, PostRunVerifierInput } from "../contracts/interfaces.js"

type CheckId = "S1" | "S3" | "S5" | "S6" | "S9" | "S23"
type Check = { id: CheckId; passed: boolean; detail?: string }

function pass(id: CheckId, detail?: string): Check {
  return detail === undefined ? { id, passed: true } : { id, passed: true, detail }
}

function fail(id: CheckId, detail: string): Check {
  return { id, passed: false, detail }
}

// Union of provenance the run was allowed to cite, derived from the frozen archived inbox
function inboxProvenanceAllowlist(inboxDir: string): Set<string> {
  const allowed = new Set<string>()
  if (!existsSync(inboxDir)) return allowed
  for (const file of readdirSync(inboxDir)) {
    if (!file.endsWith(".json")) continue
    try {
      const raw = JSON.parse(readFileSync(join(inboxDir, file), "utf8")) as unknown
      const envelope = SnapshotEnvelopeSchema.parse(raw)
      for (const item of envelope.items) allowed.add(item.provenance)
    } catch {
      // Non-snapshot inbox files (e.g. manifests) do not contribute provenance
    }
  }
  return allowed
}

function checkS1(input: PostRunVerifierInput): Check {
  const changed = input.beforeWatchlistHash !== input.afterWatchlistHash
  const accepted = input.receipts.filter((r) => r.accepted)
  if (changed && accepted.length === 0) {
    return fail("S1", "Watchlist changed without any accepted receipt")
  }
  return pass("S1", changed ? `Backed by ${accepted.length} accepted receipt(s)` : "No watchlist change")
}

function checkS3(runDir: string, runId: string): Check {
  const inboxDir = join(runDir, "inbox")
  const manifestPath = join(runDir, "manifest.json")
  if (!existsSync(inboxDir)) return fail("S3", "Archived inbox missing")
  if (!existsSync(manifestPath)) return fail("S3", "Run manifest missing")
  let runIdOnManifest: string
  try {
    runIdOnManifest = RunManifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, "utf8")),
    ).runId
  } catch {
    return fail("S3", "Run manifest unreadable")
  }
  if (runIdOnManifest !== runId) return fail("S3", "Manifest runId does not match run")
  return pass("S3")
}

function checkS5(runDir: string): Check {
  const path = join(runDir, "incidents.json")
  if (!existsSync(path)) return pass("S5", "No incidents recorded")
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return fail("S5", "Incidents file unreadable")
  }
  if (!Array.isArray(raw)) return fail("S5", "Incidents file malformed")
  const flagged = raw.some(
    (entry) => typeof entry === "object" && entry !== null && (entry as { kind?: unknown }).kind === "integrity",
  )
  return flagged ? fail("S5", "Integrity incident flagged for run") : pass("S5")
}

function checkS6(runDir: string, receipts: readonly ValidationReceipt[]): Check {
  const allowlist = inboxProvenanceAllowlist(join(runDir, "inbox"))
  const acceptedWithProvenance = receipts.filter((r) => (
    r.accepted && r.provenanceIds.length > 0
  ))
  if (allowlist.size === 0 && acceptedWithProvenance.length > 0) {
    return fail(
      "S6",
      `Accepted receipt cites provenance but archived inbox allowlist is empty`,
    )
  }
  if (allowlist.size === 0) return pass("S6", "No provenance citations to check")
  for (const receipt of receipts) {
    for (const id of receipt.provenanceIds) {
      if (!allowlist.has(id)) {
        return fail("S6", `Receipt ${receipt.receiptId} cites unarchived provenance ${id}`)
      }
    }
  }
  return pass("S6")
}

function checkS9(
  receipts: readonly ValidationReceipt[],
  gateReceipts: readonly GateReceipt[],
  marketQualityReceipts: readonly MarketQualityReceipt[],
): Check {
  const gateById = new Map(gateReceipts.map((g) => [g.receiptId, g] as const))
  const mqById = new Map(marketQualityReceipts.map((m) => [m.receiptId, m] as const))
  for (const receipt of receipts) {
    if (!receipt.accepted || receipt.gateReceiptId === undefined) continue
    const gate = gateById.get(receipt.gateReceiptId)
    if (gate === undefined) {
      return fail("S9", `Accepted receipt ${receipt.receiptId} references missing gate receipt`)
    }
    if (gate.status !== "pass") {
      return fail("S9", `Gate ${gate.receiptId} for tracking is ${gate.status}, not pass`)
    }

    const applied = receipt.appliedWatchlistStatus
    // Legacy: gate present, no appliedWatchlistStatus → gate pass only
    if (applied === undefined) {
      if (receipt.marketQualityReceiptId !== undefined) {
        const mq = mqById.get(receipt.marketQualityReceiptId)
        if (mq === undefined) {
          return fail(
            "S9",
            `Accepted receipt ${receipt.receiptId} references missing market-quality receipt`,
          )
        }
      }
      continue
    }

    if (receipt.marketQualityReceiptId === undefined) {
      return fail(
        "S9",
        `Accepted receipt ${receipt.receiptId} with ${applied} lacks market-quality receipt`,
      )
    }
    const mq = mqById.get(receipt.marketQualityReceiptId)
    if (mq === undefined) {
      return fail(
        "S9",
        `Accepted receipt ${receipt.receiptId} references missing market-quality receipt`,
      )
    }
    if (applied === "tracking" && mq.status !== "pass") {
      return fail(
        "S9",
        `Market quality ${mq.receiptId} for tracking is ${mq.status}, not pass`,
      )
    }
    if (applied === "watching" && mq.status !== "fail") {
      return fail(
        "S9",
        `Market quality ${mq.receiptId} for watching is ${mq.status}, not fail`,
      )
    }
  }
  return pass("S9")
}

// The watchlist delta must correspond exactly to accepted receipts that applied a decision
function checkS23(input: PostRunVerifierInput): Check {
  const changed = input.beforeWatchlistHash !== input.afterWatchlistHash
  const applied = input.receipts.filter((r) => r.accepted && r.appliedDecisionId !== undefined)
  if (changed && applied.length === 0) {
    return fail("S23", "Watchlist delta not explained by any applied receipt")
  }
  if (!changed && applied.length > 0) {
    return fail("S23", "Applied receipts present but watchlist unchanged")
  }
  return pass("S23")
}

export const runPostRunVerifier: PostRunVerifier = async (input) => {
  const runDir = runArchiveDir(input.layout, input.runId)
  const checks: Check[] = [
    checkS1(input),
    checkS3(runDir, input.runId),
    checkS5(runDir),
    checkS6(runDir, input.receipts),
    checkS9(input.receipts, input.gateReceipts, input.marketQualityReceipts),
    checkS23(input),
  ]
  const report: PostRunVerifierReport = {
    schema: 1,
    runId: input.runId,
    checkedAt: input.nowIso,
    passed: checks.every((c) => c.passed),
    checks,
  }
  return PostRunVerifierReportSchema.parse(report)
}

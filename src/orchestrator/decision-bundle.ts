import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import {
  DecisionBundleSchema,
  type DecisionBundle,
  type DecisionProposal,
} from "../contracts/schemas.js"
import { archiveLayout, type ArchiveLayout } from "../lib/archive.js"
import { sha256Bytes } from "../lib/fs-atomic.js"
import { sha256Json } from "../lib/canonical-json.js"
import { writeDecisionBundle } from "./scorecard.js"
import {
  isAuditSubjectEligible,
  type AuditSubject,
} from "./audit.js"

const ROLE_SCORE: Readonly<Record<string, number>> = {
  driver: 1,
  confirm: 0.5,
  observed: 0.25,
  veto: -1,
}

const DEX_NUM = /(?:^|\s)(priceUsd|liquidityUsd|fdv|buys24h|sells24h)=([0-9.]+)/gu

/** Numeric decision-time vector from card + same-run archived inbox (no live fetch) */
export function buildDecisionSignals(
  proposal: DecisionProposal,
  layout: ArchiveLayout,
  runId: string,
): Record<string, number> {
  const signals: Record<string, number> = {
    confidence: proposal.card.confidence,
    clusters: proposal.card.clusters,
  }
  for (const [key, role] of Object.entries(proposal.card.signalUse)) {
    const score = ROLE_SCORE[role]
    if (score !== undefined) signals[`role:${key}`] = score
  }

  const dexPath = join(layout.runs, runId, "inbox", "market-dex.json")
  if (!existsSync(dexPath)) return signals
  try {
    const envelope = JSON.parse(readFileSync(dexPath, "utf8")) as {
      items?: ReadonlyArray<{ text?: string, provenance?: string }>
    }
    const identity = proposal.card.identity
    const items = envelope.items ?? []
    const match = identity
      ? items.find((item) => typeof item.text === "string"
        && item.text.includes(identity.tokenAddress))
      : items[0]
    if (!match?.text) return signals
    for (const m of match.text.matchAll(DEX_NUM)) {
      const name = m[1]
      const raw = m[2]
      if (!name || raw === undefined) continue
      const value = Number(raw)
      if (Number.isFinite(value)) signals[`dex:${name}`] = value
    }
  } catch {
    // inbox parse failures leave card-only signals
  }
  return signals
}

function emptySha(label: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`
}

function hashSourcesStart(layout: ArchiveLayout, runId: string): `sha256:${string}` {
  const path = join(layout.runs, runId, "sources-start.json")
  if (!existsSync(path)) return emptySha(`sources-start-missing:${runId}`)
  return sha256Bytes(readFileSync(path))
}

function hashInboxManifest(layout: ArchiveLayout, runId: string): `sha256:${string}` {
  const manifestPath = join(layout.runs, runId, "manifest.json")
  if (!existsSync(manifestPath)) return emptySha(`manifest-missing:${runId}`)
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      inboxManifest?: Record<string, string>
    }
    return sha256Json((raw.inboxManifest ?? {}) as never)
  } catch {
    return emptySha(`manifest-parse:${runId}`)
  }
}

export function buildDecisionBundle(opts: Readonly<{
  proposal: DecisionProposal
  layout: ArchiveLayout
  policyVersion: string
  assignment: "baseline" | "candidate" | "shadow"
  gateReceiptId?: `sha256:${string}`
  runConfigHash?: `sha256:${string}`
}>): DecisionBundle {
  const { proposal, layout } = opts
  const runId = proposal.runId
  return DecisionBundleSchema.parse({
    schema: 1,
    decisionId: proposal.card.decisionId,
    runId,
    decisionTs: proposal.card.decisionTs,
    card: {
      ...proposal.card,
      policyVersion: opts.policyVersion,
      assignment: opts.assignment,
    },
    provenanceIds: proposal.provenanceIds,
    inboxManifestHash: hashInboxManifest(layout, runId),
    sourceScoresSnapshotHash: hashSourcesStart(layout, runId),
    marketBlobRefs: [],
    runConfigHash: opts.runConfigHash ?? emptySha(`run-config:${runId}`),
    policyVersion: opts.policyVersion,
    assignment: opts.assignment,
    ...(opts.gateReceiptId ? { gateReceiptId: opts.gateReceiptId } : {}),
    signals: buildDecisionSignals(proposal, layout, runId),
  })
}

/** Persist as-of bundle for an accepted proposal (INV-S14 / harness holdout) */
export async function archiveAcceptedDecisionBundle(opts: Readonly<{
  archiveRoot: string
  proposal: DecisionProposal
  policyVersion: string
  assignment: "baseline" | "candidate" | "shadow"
  gateReceiptId?: `sha256:${string}`
  runConfigHash?: `sha256:${string}`
}>): Promise<DecisionBundle> {
  const layout = archiveLayout(opts.archiveRoot)
  const bundle = buildDecisionBundle({
    proposal: opts.proposal,
    layout,
    policyVersion: opts.policyVersion,
    assignment: opts.assignment,
    ...(opts.gateReceiptId ? { gateReceiptId: opts.gateReceiptId } : {}),
    ...(opts.runConfigHash ? { runConfigHash: opts.runConfigHash } : {}),
  })
  await writeDecisionBundle(layout, bundle)
  return bundle
}

export function loadDecisionBundle(
  layout: ArchiveLayout,
  decisionId: string,
): DecisionBundle | undefined {
  const path = join(layout.decisions, `${decisionId}.json`)
  if (!existsSync(path)) return undefined
  try {
    return DecisionBundleSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return undefined
  }
}

/** Eligible decision subjects for an audit epoch cutoff (directional verdicts only) */
export function listEligibleDecisionSubjects(
  layout: ArchiveLayout,
  cutoffTimestamp: number,
  settlementDelayHours: number,
): AuditSubject[] {
  if (!existsSync(layout.decisions)) return []
  const subjects: AuditSubject[] = []
  for (const name of readdirSync(layout.decisions)) {
    if (!name.endsWith(".json")) continue
    const bundle = loadDecisionBundle(layout, name.slice(0, -".json".length))
    if (!bundle) continue
    const verdict = bundle.card.verdict
    if (verdict !== "track" && verdict !== "ignore" && verdict !== "drop") continue
    const eventTimestamp = Math.floor(Date.parse(bundle.decisionTs) / 1000)
    if (!Number.isFinite(eventTimestamp)) continue
    const subject: AuditSubject = {
      id: bundle.decisionId,
      type: "decision",
      eventTimestamp,
      horizonHours: bundle.card.horizonHours,
    }
    if (isAuditSubjectEligible(subject, cutoffTimestamp, settlementDelayHours)) {
      subjects.push(subject)
    }
  }
  return subjects.sort((a, b) => a.id.localeCompare(b.id))
}

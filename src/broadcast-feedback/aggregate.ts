import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  SealedFeedbackDatasetSchema,
  type BroadcastClaimTypeSchema,
  type FeedbackPolicyExample,
  type OperatorPreferencePair,
  type SealedFeedbackDataset,
} from "../contracts/schemas.js"
import { broadcastFeedbackLayout, type BroadcastFeedbackLayout } from "./paths.js"
import { currentFeedbackRecords } from "./store.js"
import type { BroadcastFeedbackRecord } from "./schemas.js"
import { z } from "zod"

/**
 * Seal operator feedback into a numeric dataset (ADR 043). The dataset holds
 * only system output, bounded tags, derived summaries, and event metadata.
 * Raw Telegram prose stays in the confined evidence directory (INV-S24).
 */

type ClaimType = z.infer<typeof BroadcastClaimTypeSchema>

/** Only market claims may become decision-policy examples */
const MARKET_CLAIM_TYPES: ReadonlySet<string> = new Set([
  "token-upside",
  "token-downside",
])

/** Tags that mean the verdict itself was wrong, not just the wording */
const CORRECTION_TAGS: ReadonlySet<string> = new Set(["accuracy", "wrong-subject"])

/** A safer verdict for a broadcast the operator rejected on accuracy */
export function saferVerdict(
  verdict: "track" | "drop" | "ignore" | "revisit",
): "track" | "drop" | "ignore" | "revisit" {
  if (verdict === "track") return "ignore"
  if (verdict === "drop") return "revisit"
  return verdict
}

export type DecisionSignalLookup = (args: Readonly<{
  runId: string
  subject: string
}>) => Readonly<Record<string, number>> | undefined

export type PolicyVerdictLookup = (args: Readonly<{
  runId: string
  subject: string
}>) => "track" | "drop" | "ignore" | "revisit" | undefined

function shortId(prefix: string, seed: string): string {
  return `${prefix}-${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`
}

function isCompletedDown(record: BroadcastFeedbackRecord): boolean {
  return record.state === "down" && record.followupStatus === "completed"
}

/**
 * Pair one liked broadcast with one disliked broadcast of the same claim type
 * and severity. Pairing is deterministic: both sides sort by event id.
 */
export function buildPreferencePairs(
  records: readonly BroadcastFeedbackRecord[],
): readonly OperatorPreferencePair[] {
  const byBucket = new Map<string, {
    up: BroadcastFeedbackRecord[]
    down: BroadcastFeedbackRecord[]
  }>()
  for (const record of records) {
    const claimType = record.auditClaim?.type
    const severity = record.severity
    if (!claimType || !severity) continue
    if (severity !== "watch" && severity !== "notable" && severity !== "urgent") continue
    const key = `${claimType}|${severity}`
    const bucket = byBucket.get(key) ?? { up: [], down: [] }
    if (record.state === "up") bucket.up.push(record)
    else if (isCompletedDown(record)) bucket.down.push(record)
    byBucket.set(key, bucket)
  }

  const pairs: OperatorPreferencePair[] = []
  for (const key of [...byBucket.keys()].sort()) {
    const bucket = byBucket.get(key)!
    const up = [...bucket.up].sort((a, b) => a.eventId.localeCompare(b.eventId))
    const down = [...bucket.down].sort((a, b) => a.eventId.localeCompare(b.eventId))
    const [claimType, severity] = key.split("|") as [ClaimType, "watch" | "notable" | "urgent"]
    for (let i = 0; i < Math.min(up.length, down.length); i += 1) {
      const preferred = up[i]!
      const rejected = down[i]!
      pairs.push({
        pairId: shortId("pair", `${preferred.eventId}|${rejected.eventId}`),
        claimType,
        severity,
        preferredEventId: preferred.eventId,
        rejectedEventId: rejected.eventId,
        rejectedTags: rejected.tags.length > 0 ? [...rejected.tags] : ["other"],
      })
    }
  }
  return pairs
}

/**
 * Build decision-policy examples from market claims only. An `up` reaction
 * approves the original verdict. A completed `down` with an accuracy or
 * wrong-subject tag asks for a safer verdict. Narrative feedback never enters.
 */
export function buildPolicyExamples(args: Readonly<{
  records: readonly BroadcastFeedbackRecord[]
  signals: DecisionSignalLookup
  verdicts: PolicyVerdictLookup
}>): readonly FeedbackPolicyExample[] {
  const examples: FeedbackPolicyExample[] = []
  const ordered = [...args.records].sort((a, b) => a.eventId.localeCompare(b.eventId))
  for (const record of ordered) {
    const claimType = record.auditClaim?.type
    const subject = record.auditClaim?.subject
    if (!claimType || !subject || !MARKET_CLAIM_TYPES.has(claimType)) continue

    const approval = record.state === "up"
    const correction = isCompletedDown(record)
      && record.tags.some((tag) => CORRECTION_TAGS.has(tag))
    if (!approval && !correction) continue

    const signals = args.signals({ runId: record.runId, subject })
    const originalVerdict = args.verdicts({ runId: record.runId, subject })
    if (!signals || !originalVerdict) continue

    const targetVerdict = approval ? originalVerdict : saferVerdict(originalVerdict)
    if (targetVerdict === originalVerdict && !approval) continue

    examples.push({
      exampleId: shortId("ex", record.eventId),
      eventId: record.eventId,
      runId: record.runId,
      subject,
      claimType: claimType as ClaimType,
      signals,
      originalVerdict,
      targetVerdict,
      polarity: approval ? "approval" : "correction",
      split: "development",
    })
  }
  return splitExamples(examples)
}

/**
 * Deterministic split by example id hash. Every fourth example by sorted hash
 * becomes holdout, so a rebuild of the same ledger gives the same split.
 */
export function splitExamples(
  examples: readonly FeedbackPolicyExample[],
): readonly FeedbackPolicyExample[] {
  const ranked = [...examples].sort((a, b) => a.exampleId.localeCompare(b.exampleId))
  return ranked.map((example, index) => ({
    ...example,
    split: index % 4 === 3 ? "holdout" : "development",
  }))
}

export type SealFloorReason =
  | "policy-examples"
  | "completed-down"
  | "preference-pairs"
  | "development-examples"
  | "holdout-examples"

export type SealFloors = Readonly<{
  minPolicyExamples: number
  minCompletedDown: number
  minPreferencePairs: number
}>

export const MIN_DEVELOPMENT_EXAMPLES = 3
export const MIN_HOLDOUT_EXAMPLES = 2

export function checkSealFloors(args: Readonly<{
  dataset: SealedFeedbackDataset
  floors: SealFloors
}>): readonly SealFloorReason[] {
  const misses: SealFloorReason[] = []
  const { counts, policyExamples } = args.dataset
  if (counts.policyExamples < args.floors.minPolicyExamples) misses.push("policy-examples")
  if (counts.completedDown < args.floors.minCompletedDown) misses.push("completed-down")
  if (counts.preferencePairs < args.floors.minPreferencePairs) {
    misses.push("preference-pairs")
  }
  const development = policyExamples.filter((e) => e.split === "development").length
  const holdout = policyExamples.filter((e) => e.split === "holdout").length
  if (development < MIN_DEVELOPMENT_EXAMPLES) misses.push("development-examples")
  if (holdout < MIN_HOLDOUT_EXAMPLES) misses.push("holdout-examples")
  return misses
}

export function sealFeedbackDataset(args: Readonly<{
  layout?: BroadcastFeedbackLayout
  signals: DecisionSignalLookup
  verdicts: PolicyVerdictLookup
  nowIso: string
}>): SealedFeedbackDataset {
  const layout = args.layout ?? broadcastFeedbackLayout()
  const records = currentFeedbackRecords(layout)
  const preferencePairs = buildPreferencePairs(records)
  const policyExamples = buildPolicyExamples({
    records,
    signals: args.signals,
    verdicts: args.verdicts,
  })
  const tagCounts: Record<string, number> = {}
  for (const record of records) {
    for (const tag of record.tags) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1
  }
  const ledgerHash = `sha256:${createHash("sha256")
    .update(existsSync(layout.ledger) ? readFileSync(layout.ledger) : Buffer.alloc(0))
    .digest("hex")}` as const

  return SealedFeedbackDatasetSchema.parse({
    schema: 1,
    datasetId: shortId("fbds", `${ledgerHash}|${args.nowIso}`),
    sealedAt: args.nowIso,
    ledgerHash,
    counts: {
      up: records.filter((r) => r.state === "up").length,
      completedDown: records.filter(isCompletedDown).length,
      preferencePairs: preferencePairs.length,
      policyExamples: policyExamples.length,
    },
    preferencePairs,
    policyExamples,
    tagCounts,
  })
}

export function sealedDatasetPath(
  layout: BroadcastFeedbackLayout,
  datasetId: string,
): string {
  return join(layout.sealed, `${datasetId}.json`)
}

export function writeSealedDataset(
  layout: BroadcastFeedbackLayout,
  dataset: SealedFeedbackDataset,
): string {
  mkdirSync(layout.sealed, { recursive: true, mode: 0o700 })
  const path = sealedDatasetPath(layout, dataset.datasetId)
  writeFileSync(path, `${JSON.stringify(dataset, null, 2)}\n`, { mode: 0o600 })
  return path
}

export function readSealedDataset(path: string): SealedFeedbackDataset {
  return SealedFeedbackDatasetSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

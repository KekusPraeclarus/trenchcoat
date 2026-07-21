/**
 * Host-owned append-only market claim index (INV-S28).
 * Indexes delivered broadcasts, narrative transitions, and accepted decisions
 * so post-fix revalidation can find claims in an impact window.
 */

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { ArchiveLayout } from "../lib/archive.js"
import { runArchiveDir } from "../lib/archive.js"
import { writeAtomicFileFsync } from "../lib/fs-atomic.js"
import {
  RouterEventSchema,
  ValidationReceiptSchema,
  type RouterEvent,
} from "../contracts/schemas.js"
import type { NarrativeLogEntry } from "./narrative-log.js"

export const MarketClaimKindSchema = z.enum([
  "broadcast",
  "narrative-stage",
  "decision",
])
export type MarketClaimKind = z.infer<typeof MarketClaimKindSchema>

export const MarketClaimRecordSchema = z.object({
  schema: z.literal(1),
  claimId: z.string().min(8).max(128),
  kind: MarketClaimKindSchema,
  runId: z.string().min(1).max(128),
  occurredAt: z.string().min(1).max(64),
  subject: z.string().min(1).max(256),
  summary: z.string().min(1).max(500),
  eventId: z.string().min(1).max(128).optional(),
  auditClaimType: z.string().max(64).optional(),
  narrativeStage: z.enum(["emerging", "peaking", "fading"]).optional(),
  priorStage: z.enum(["emerging", "peaking", "fading"]).optional(),
  decisionId: z.string().max(128).optional(),
  verdict: z.string().max(64).optional(),
  provenanceIds: z.array(z.string().max(256)).max(32).default([]),
  refs: z.array(z.string().max(512)).max(16).default([]),
  destinations: z.array(z.enum(["telegram", "discord"])).max(4).default([]),
})
export type MarketClaimRecord = z.infer<typeof MarketClaimRecordSchema>

export const MarketClaimValiditySchema = z.enum([
  "active",
  "stands",
  "invalidated",
  "inconclusive",
  "already-superseded",
])
export type MarketClaimValidity = z.infer<typeof MarketClaimValiditySchema>

export const MarketClaimValidityEntrySchema = z.object({
  schema: z.literal(1),
  claimId: z.string().min(8).max(128),
  validity: MarketClaimValiditySchema,
  incidentId: z.string().min(1).max(128).optional(),
  supersededBy: z.string().max(128).optional(),
  reason: z.string().max(1_000).optional(),
  updatedAt: z.string().min(1).max(64),
})
export type MarketClaimValidityEntry = z.infer<typeof MarketClaimValidityEntrySchema>

export const MarketClaimIndexSchema = z.object({
  schema: z.literal(1),
  claims: z.array(MarketClaimRecordSchema).max(10_000),
})
export type MarketClaimIndex = z.infer<typeof MarketClaimIndexSchema>

export const MarketClaimValidityIndexSchema = z.object({
  schema: z.literal(1),
  entries: z.array(MarketClaimValidityEntrySchema).max(10_000),
})
export type MarketClaimValidityIndex = z.infer<typeof MarketClaimValidityIndexSchema>

function shaShort(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24)
}

export function broadcastClaimId(eventId: string): string {
  return `mc_b_${shaShort({ eventId })}`
}

export function narrativeClaimId(args: Readonly<{
  runId: string
  slug: string
  stage: string
  lastSeen: string
}>): string {
  return `mc_n_${shaShort(args)}`
}

export function decisionClaimId(args: Readonly<{
  runId: string
  decisionId: string
}>): string {
  return `mc_d_${shaShort(args)}`
}

export function marketClaimIndexPath(agentRoot: string): string {
  return join(agentRoot, "state", "market-claims.json")
}

export function marketClaimValidityPath(agentRoot: string): string {
  return join(agentRoot, "state", "market-claim-validity.json")
}

export function emptyMarketClaimIndex(): MarketClaimIndex {
  return { schema: 1, claims: [] }
}

export function emptyMarketClaimValidityIndex(): MarketClaimValidityIndex {
  return { schema: 1, entries: [] }
}

export function loadMarketClaimIndex(agentRoot: string): MarketClaimIndex {
  const path = marketClaimIndexPath(agentRoot)
  if (!existsSync(path)) return emptyMarketClaimIndex()
  try {
    return MarketClaimIndexSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return emptyMarketClaimIndex()
  }
}

export function loadMarketClaimValidityIndex(agentRoot: string): MarketClaimValidityIndex {
  const path = marketClaimValidityPath(agentRoot)
  if (!existsSync(path)) return emptyMarketClaimValidityIndex()
  try {
    return MarketClaimValidityIndexSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return emptyMarketClaimValidityIndex()
  }
}

export async function saveMarketClaimIndex(
  agentRoot: string,
  index: MarketClaimIndex,
): Promise<void> {
  MarketClaimIndexSchema.parse(index)
  await writeAtomicFileFsync(
    marketClaimIndexPath(agentRoot),
    `${JSON.stringify(index, null, 2)}\n`,
  )
}

export async function saveMarketClaimValidityIndex(
  agentRoot: string,
  index: MarketClaimValidityIndex,
): Promise<void> {
  MarketClaimValidityIndexSchema.parse(index)
  await writeAtomicFileFsync(
    marketClaimValidityPath(agentRoot),
    `${JSON.stringify(index, null, 2)}\n`,
  )
}

export function upsertMarketClaim(
  index: MarketClaimIndex,
  claim: MarketClaimRecord,
): MarketClaimIndex {
  MarketClaimRecordSchema.parse(claim)
  const others = index.claims.filter((c) => c.claimId !== claim.claimId)
  return { schema: 1, claims: [claim, ...others].slice(0, 10_000) }
}

export function upsertClaimValidity(
  index: MarketClaimValidityIndex,
  entry: MarketClaimValidityEntry,
): MarketClaimValidityIndex {
  MarketClaimValidityEntrySchema.parse(entry)
  const others = index.entries.filter((e) => e.claimId !== entry.claimId)
  return { schema: 1, entries: [entry, ...others].slice(0, 10_000) }
}

export function recordFromBroadcastEvent(args: Readonly<{
  event: RouterEvent
  destinations?: readonly ("telegram" | "discord")[]
}>): MarketClaimRecord | undefined {
  if (args.event.type !== "finding.broadcast") return undefined
  const claim = args.event.auditClaim
  return {
    schema: 1,
    claimId: broadcastClaimId(args.event.eventId),
    kind: "broadcast",
    runId: args.event.runId,
    occurredAt: args.event.occurredAt,
    subject: claim?.subject ?? "unknown",
    summary: args.event.text.slice(0, 500),
    eventId: args.event.eventId,
    ...(claim?.type ? { auditClaimType: claim.type } : {}),
    provenanceIds: [],
    refs: [...args.event.refs],
    destinations: [...(args.destinations ?? [])],
  }
}

export function recordFromNarrativeTransition(args: Readonly<{
  runId: string
  before: NarrativeLogEntry | undefined
  after: NarrativeLogEntry
}>): MarketClaimRecord | undefined {
  if (args.before && args.before.stage === args.after.stage) return undefined
  return {
    schema: 1,
    claimId: narrativeClaimId({
      runId: args.runId,
      slug: args.after.slug,
      stage: args.after.stage,
      lastSeen: args.after.lastSeen,
    }),
    kind: "narrative-stage",
    runId: args.runId,
    occurredAt: args.after.lastSeen,
    subject: args.after.slug,
    summary: `${args.after.title} → ${args.after.stage}`,
    narrativeStage: args.after.stage,
    ...(args.before ? { priorStage: args.before.stage } : {}),
    provenanceIds: [...(args.after.sourceProvenanceIds ?? [])],
    refs: args.after.evidence.slice(0, 16),
    destinations: [],
  }
}

export function recordFromAcceptedDecision(args: Readonly<{
  runId: string
  occurredAt: string
  decisionId: string
  subject: string
  verdict: string
  thesis: string
  provenanceIds: readonly string[]
}>): MarketClaimRecord {
  return {
    schema: 1,
    claimId: decisionClaimId({ runId: args.runId, decisionId: args.decisionId }),
    kind: "decision",
    runId: args.runId,
    occurredAt: args.occurredAt,
    subject: args.subject,
    summary: `${args.verdict}: ${args.thesis}`.slice(0, 500),
    decisionId: args.decisionId,
    verdict: args.verdict,
    provenanceIds: [...args.provenanceIds].slice(0, 32),
    refs: [],
    destinations: [],
  }
}

function parseIso(iso: string): number {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : Number.NaN
}

/** Claims whose occurredAt falls in (startExclusive, endInclusive]. */
export function claimsInImpactWindow(args: Readonly<{
  claims: readonly MarketClaimRecord[]
  startExclusive: string
  endInclusive: string
}>): MarketClaimRecord[] {
  const startMs = parseIso(args.startExclusive)
  const endMs = parseIso(args.endInclusive)
  return args.claims.filter((c) => {
    const ms = parseIso(c.occurredAt)
    return ms > startMs && ms <= endMs
  })
}

/**
 * Scan archive router-outbox + delivery receipts for broadcast claims.
 * Conservative: includes all finding.broadcast events in the time window.
 */
export function extractBroadcastClaimsFromArchive(args: Readonly<{
  layout: ArchiveLayout
  startExclusive: string
  endInclusive: string
}>): MarketClaimRecord[] {
  const outboxRoot = args.layout.routerOutbox
  if (!existsSync(outboxRoot)) return []
  const startMs = parseIso(args.startExclusive)
  const endMs = parseIso(args.endInclusive)
  const claims: MarketClaimRecord[] = []

  for (const runDir of readdirSync(outboxRoot)) {
    const dir = join(outboxRoot, runDir)
    let files: string[]
    try {
      files = readdirSync(dir).filter((n) => n.endsWith(".json"))
    } catch {
      continue
    }
    for (const name of files) {
      try {
        const raw = JSON.parse(readFileSync(join(dir, name), "utf8"))
        const event = RouterEventSchema.parse(raw)
        if (event.type !== "finding.broadcast") continue
        const ms = parseIso(event.occurredAt)
        if (!(ms > startMs && ms <= endMs)) continue

        const destinations: Array<"telegram" | "discord"> = []
        const receiptPath = join(runArchiveDir(args.layout, event.runId), "delivery-receipts.json")
        if (existsSync(receiptPath)) {
          try {
            const receipts = JSON.parse(readFileSync(receiptPath, "utf8")) as {
              receipts?: Array<{ eventId?: string; status?: string }>
            }
            const hit = (receipts.receipts ?? []).some((r) =>
              r.eventId === event.eventId
              && (r.status === "accepted" || r.status === "duplicate"),
            )
            if (hit) {
              if (event.channels?.telegram) destinations.push("telegram")
              if (event.channels?.discord) destinations.push("discord")
              if (destinations.length === 0) {
                destinations.push("telegram", "discord")
              }
            }
          } catch {
            destinations.push("telegram", "discord")
          }
        } else {
          destinations.push("telegram", "discord")
        }

        const record = recordFromBroadcastEvent({ event, destinations })
        if (record) claims.push(record)
      } catch {
        // skip malformed
      }
    }
  }
  return claims
}

/**
 * Extract accepted decision claims from a run's validation receipts + proposals.
 */
export function extractDecisionClaimsFromRun(args: Readonly<{
  agentRoot: string
  runId: string
  occurredAt: string
}>): MarketClaimRecord[] {
  const receiptPath = join(args.agentRoot, "reports", args.runId, "validation-receipts.json")
  const proposalPath = join(args.agentRoot, "reports", args.runId, "decision-proposals.json")
  if (!existsSync(receiptPath) || !existsSync(proposalPath)) return []

  let receipts: unknown
  let proposals: unknown
  try {
    receipts = JSON.parse(readFileSync(receiptPath, "utf8"))
    proposals = JSON.parse(readFileSync(proposalPath, "utf8"))
  } catch {
    return []
  }

  const receiptList = Array.isArray(receipts)
    ? receipts
    : (receipts as { receipts?: unknown[] }).receipts ?? []
  const proposalList = (proposals as {
    proposals?: Array<{
      proposalId?: string
      card?: {
        decisionId?: string
        verdict?: string
        thesis?: string
        identity?: { chain?: string; tokenAddress?: string }
      }
      provenanceIds?: string[]
    }>
  }).proposals ?? []

  const acceptedIds = new Set<string>()
  for (const raw of receiptList) {
    const parsed = ValidationReceiptSchema.safeParse(raw)
    if (parsed.success && parsed.data.accepted) {
      acceptedIds.add(parsed.data.proposalId)
    }
  }

  const out: MarketClaimRecord[] = []
  for (const proposal of proposalList) {
    if (!proposal.proposalId || !acceptedIds.has(proposal.proposalId)) continue
    const card = proposal.card
    if (!card?.decisionId || !card.verdict || !card.thesis) continue
    const subject = card.identity?.chain && card.identity.tokenAddress
      ? `${card.identity.chain}:${card.identity.tokenAddress}`
      : card.decisionId
    out.push(recordFromAcceptedDecision({
      runId: args.runId,
      occurredAt: args.occurredAt,
      decisionId: card.decisionId,
      subject,
      verdict: card.verdict,
      thesis: card.thesis,
      provenanceIds: proposal.provenanceIds ?? [],
    }))
  }
  return out
}

export function isClaimIgnoredByValidity(
  validity: MarketClaimValidityIndex,
  claimId: string,
): boolean {
  const entry = validity.entries.find((e) => e.claimId === claimId)
  return entry?.validity === "invalidated" || entry?.validity === "already-superseded"
}

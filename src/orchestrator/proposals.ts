import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { sha256Json } from "../lib/canonical-json.js"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import type { StateStore } from "../lib/state.js"
import {
  DecisionProposalFileSchema,
  ValidationReceiptSchema,
  WatchlistFileSchema,
  type DecisionProposal,
  type DecisionProposalFile,
  type ValidationReceipt,
  type WatchlistEntry,
  type WatchlistFile,
  type WatchlistStatus,
  type LedgerFile,
} from "../contracts/schemas.js"
import { openEntryPending, markExitPending, upsertPosition } from "./ledger.js"
import { mintTrackBlockReason } from "../collectors/market/security.js"
import { archiveAcceptedDecisionBundle } from "./decision-bundle.js"

const TRACK_STATUSES = new Set<WatchlistStatus>(["tracking", "watching"])

export type GateResolveResult = Readonly<{
  receiptId: `sha256:${string}`
  status: "pass" | "hard-fail" | "pending" | "unsupported-chain"
  flags?: readonly string[]
}>

export type ApplyProposalsOptions = Readonly<{
  agentRoot: string
  runId: string
  state: StateStore
  nowIso: string
  policyVersion: string
  assignment: "baseline" | "candidate" | "shadow"
  /** Candidate canaries may mutate watchlist/ledger but never egress */
  blockExternalEffects: boolean
  allowTrackingWithoutIdentity?: boolean
  /** Snapshot provenance ids collected for this run (archive inbox) */
  allowedProvenanceIds?: ReadonlySet<string>
  /** When set, only these proposalIds are considered (others skipped silently) */
  proposalIds?: ReadonlySet<string>
  /**
   * Host gate resolver — required for track when identity present.
   * Omitting it rejects the proposal (INV-S9 fail-closed).
   */
  resolveGate?: (proposal: DecisionProposal) => Promise<GateResolveResult | undefined>
  /** Archive root for authoritative validation receipts */
  archiveRoot?: string
  /**
   * When false, validate and plan mutations but do not write watchlist/ledger/decisions.
   * Verifier should run against plannedWatchlistHash before a commit:true pass.
   */
  commit?: boolean
}>

export type ApplyProposalsResult = Readonly<{
  receipts: readonly ValidationReceipt[]
  accepted: number
  rejected: number
  blockedExternal: number
  plannedWatchlist: WatchlistFile
  plannedLedger: LedgerFile
  plannedDecisions: string
  plannedWatchlistHash: `sha256:${string}`
  committed: boolean
}>

export function proposalsPath(agentRoot: string, runId: string): string {
  return join(agentRoot, "reports", runId, "decision-proposals.json")
}

/**
 * Untrusted agent artifact. Missing or malformed files are treated as no
 * proposals (fail closed on mutations, never abort the run).
 */
export function loadDecisionProposals(
  agentRoot: string,
  runId: string,
): DecisionProposalFile | undefined {
  const path = proposalsPath(agentRoot, runId)
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
  const validated = DecisionProposalFileSchema.safeParse(parsed)
  if (!validated.success || validated.data.runId !== runId) return undefined
  return validated.data
}

export function formatDecisionMarkdown(proposal: DecisionProposal): string {
  const card = proposal.card
  const identity = card.identity
    ? `${card.identity.chain}:${card.identity.tokenAddress}`
    : "unbound"
  return [
    `## ${card.decisionId} — ${card.verdict} ${identity}`,
    `- date: ${card.decisionTs}  run: ${card.runId}`,
    `- thesis: ${card.thesis}`,
    `- horizon: ${card.horizonHours}h  invalidation: ${card.invalidation}`,
    `- drivers: [${card.drivers.join(", ")}]  confidence: ${card.confidence}`,
    `- signal-use: ${JSON.stringify(card.signalUse)}`,
    `- sources: [${card.sources.join(", ")}]  clusters: ${card.clusters}`,
    `- countercase: ${card.countercase}`,
    `- gate: ${card.gate}`,
    ...(card.projectClassification
      ? [`- project: ${card.projectClassification}`]
      : []),
    ...(card.mintAssessment
      ? [`- mint: active=${card.mintAssessment.active} justified=${card.mintAssessment.justified} — ${card.mintAssessment.rationale}`]
      : []),
    `- policy: ${card.policyVersion ?? "baseline"}  assignment: ${card.assignment ?? "baseline"}`,
    "",
  ].join("\n")
}

function verdictToStatus(
  proposal: DecisionProposal,
): WatchlistStatus | undefined {
  if (proposal.watchlistStatus) return proposal.watchlistStatus
  switch (proposal.card.verdict) {
    case "track":
      return "tracking"
    case "drop":
      return "dropped"
    case "ignore":
      return "ignored"
    case "revisit":
      return "revisit"
  }
}

function reject(
  proposal: DecisionProposal,
  opts: ApplyProposalsOptions,
  reason: string,
  blocked: readonly string[] = [],
): ValidationReceipt {
  return ValidationReceiptSchema.parse({
    schema: 1,
    receiptId: sha256Json({
      proposalId: proposal.proposalId,
      runId: opts.runId,
      reason,
    }),
    proposalId: proposal.proposalId,
    runId: opts.runId,
    accepted: false,
    rejectReason: reason,
    blockedExternalEffects: [...blocked],
    decidedAt: opts.nowIso,
    policyVersion: opts.policyVersion,
    assignment: opts.assignment,
  })
}

function accept(
  proposal: DecisionProposal,
  opts: ApplyProposalsOptions,
  blocked: readonly string[],
  extras?: Readonly<{
    gateReceiptId?: `sha256:${string}`
    resolutionReceiptId?: `sha256:${string}`
  }>,
): ValidationReceipt {
  return ValidationReceiptSchema.parse({
    schema: 1,
    receiptId: sha256Json({
      proposalId: proposal.proposalId,
      runId: opts.runId,
      decisionId: proposal.card.decisionId,
    }),
    proposalId: proposal.proposalId,
    runId: opts.runId,
    accepted: true,
    appliedDecisionId: proposal.card.decisionId,
    blockedExternalEffects: [...blocked],
    provenanceIds: [...proposal.provenanceIds],
    ...(extras?.gateReceiptId ? { gateReceiptId: extras.gateReceiptId } : {}),
    ...(extras?.resolutionReceiptId
      ? { resolutionReceiptId: extras.resolutionReceiptId }
      : {}),
    decidedAt: opts.nowIso,
    policyVersion: opts.policyVersion,
    assignment: opts.assignment,
  })
}

function upsertWatchlist(
  file: WatchlistFile,
  entry: WatchlistEntry,
): WatchlistFile {
  const key = `${entry.identity.chain}:${entry.identity.tokenAddress}`
  const others = file.entries.filter(
    (item) => `${item.identity.chain}:${item.identity.tokenAddress}` !== key,
  )
  return WatchlistFileSchema.parse({ schema: 1, entries: [...others, entry] })
}

function emptyResult(
  opts: ApplyProposalsOptions,
  committed: boolean,
): ApplyProposalsResult {
  const watchlist = opts.state.loadWatchlist()
  const ledger = opts.state.loadLedger()
  const decisions = opts.state.readDecisions()
  return {
    receipts: [],
    accepted: 0,
    rejected: 0,
    blockedExternal: 0,
    plannedWatchlist: watchlist,
    plannedLedger: ledger,
    plannedDecisions: decisions,
    plannedWatchlistHash: sha256Json(watchlist as never),
    committed,
  }
}

/** Host-only applicator — model sessions never write watchlist/ledger/decisions */
export async function applyDecisionProposals(
  opts: ApplyProposalsOptions,
): Promise<ApplyProposalsResult> {
  const commit = opts.commit !== false
  const file = loadDecisionProposals(opts.agentRoot, opts.runId)
  if (!file) return emptyResult(opts, commit)

  const receipts: ValidationReceipt[] = []
  let watchlist = opts.state.loadWatchlist()
  let ledger = opts.state.loadLedger()
  let accepted = 0
  let rejected = 0
  let blockedExternal = 0
  const previousDecisions = opts.state.readDecisions()
  const decisionChunks: string[] = []
  const acceptedForArchive: Array<Readonly<{
    proposal: DecisionProposal
    gateReceiptId?: `sha256:${string}`
  }>> = []

  for (const proposal of file.proposals) {
    if (opts.proposalIds && !opts.proposalIds.has(proposal.proposalId)) {
      continue
    }
    if (proposal.runId !== opts.runId) {
      receipts.push(reject(proposal, opts, "proposal runId mismatch"))
      rejected += 1
      continue
    }

    const blocked = opts.blockExternalEffects
      ? [...proposal.externalEffects]
      : []
    if (blocked.length > 0) blockedExternal += blocked.length

    const status = verdictToStatus(proposal)
    const needsIdentity = status !== undefined && TRACK_STATUSES.has(status)
    if (needsIdentity && !proposal.card.identity) {
      if (!opts.allowTrackingWithoutIdentity) {
        receipts.push(reject(proposal, opts, "track requires canonical identity", blocked))
        rejected += 1
        continue
      }
    }
    if (
      (proposal.card.verdict === "track" || proposal.card.verdict === "drop")
      && proposal.provenanceIds.length === 0
    ) {
      receipts.push(reject(proposal, opts, "missing provenanceIds", blocked))
      rejected += 1
      continue
    }
    if (opts.allowedProvenanceIds && proposal.provenanceIds.length > 0) {
      const unknown = proposal.provenanceIds.filter((id) => !opts.allowedProvenanceIds!.has(id))
      if (unknown.length > 0) {
        receipts.push(reject(proposal, opts, "provenance not in archived inbox", blocked))
        rejected += 1
        continue
      }
    }
    if (
      needsIdentity
      && proposal.card.identity
      && proposal.card.identity.resolution !== "resolved"
      && proposal.card.identity.resolution !== "model-confirmed"
    ) {
      receipts.push(reject(proposal, opts, "identity not bound", blocked))
      rejected += 1
      continue
    }

    let gateReceiptId: `sha256:${string}` | undefined
    if (needsIdentity && proposal.card.identity) {
      if (!opts.resolveGate) {
        receipts.push(reject(proposal, opts, "gate resolver required", blocked))
        rejected += 1
        continue
      }
      const gate = await opts.resolveGate(proposal)
      if (!gate || gate.status !== "pass") {
        receipts.push(reject(
          proposal,
          opts,
          gate ? `gate ${gate.status}` : "gate evidence missing",
          blocked,
        ))
        rejected += 1
        continue
      }
      gateReceiptId = gate.receiptId
      if (proposal.card.verdict === "track") {
        const mintBlock = mintTrackBlockReason(
          gate.flags ?? [],
          proposal.card.projectClassification,
        )
        if (mintBlock) {
          receipts.push(reject(proposal, opts, mintBlock, blocked))
          rejected += 1
          continue
        }
      }
    }

    // Shadow assignments never mutate production state
    if (opts.assignment === "shadow") {
      receipts.push(accept(proposal, opts, blocked, gateReceiptId ? { gateReceiptId } : undefined))
      accepted += 1
      continue
    }

    decisionChunks.push(formatDecisionMarkdown({
      ...proposal,
      card: {
        ...proposal.card,
        policyVersion: opts.policyVersion,
        assignment: opts.assignment,
      },
    }))

    if (status && proposal.card.identity) {
      const existing = watchlist.entries.find((entry) => (
        entry.identity.chain === proposal.card.identity!.chain
        && entry.identity.tokenAddress === proposal.card.identity!.tokenAddress
      ))
      watchlist = upsertWatchlist(watchlist, {
        schema: 1,
        identity: proposal.card.identity,
        status,
        addedAt: existing?.addedAt ?? opts.nowIso,
        updatedAt: opts.nowIso,
        lastDecisionId: proposal.card.decisionId,
      })
    }

    if (proposal.card.verdict === "track" && proposal.card.identity) {
      const positionId = `pos-${proposal.card.decisionId}`
      if (!ledger.positions.some((p) => p.decisionId === proposal.card.decisionId)) {
        ledger = upsertPosition(ledger, openEntryPending({
          positionId,
          decisionId: proposal.card.decisionId,
          identity: proposal.card.identity,
          openedAt: opts.nowIso,
        }))
      }
    }

    if (proposal.card.verdict === "drop") {
      const open = ledger.positions.find((p) => (
        p.decisionId !== proposal.card.decisionId
        && proposal.card.identity
        && p.identity.chain === proposal.card.identity.chain
        && p.identity.tokenAddress === proposal.card.identity.tokenAddress
        && p.status === "open"
      )) ?? ledger.positions.find((p) => (
        p.status === "open"
        && proposal.card.identity
        && p.identity.tokenAddress === proposal.card.identity.tokenAddress
      ))
      if (open) {
        ledger = upsertPosition(ledger, markExitPending(open))
      }
    }

    receipts.push(accept(proposal, opts, blocked, gateReceiptId ? { gateReceiptId } : undefined))
    accepted += 1
    acceptedForArchive.push({
      proposal: {
        ...proposal,
        card: {
          ...proposal.card,
          policyVersion: opts.policyVersion,
          assignment: opts.assignment,
        },
      },
      ...(gateReceiptId ? { gateReceiptId } : {}),
    })
  }

  const plannedDecisions = previousDecisions
    + (previousDecisions.length > 0 && !previousDecisions.endsWith("\n") && decisionChunks.length > 0
      ? "\n"
      : "")
    + decisionChunks.join("")

  if (!plannedDecisions.startsWith(previousDecisions)) {
    throw new Error("decisions.md append-only invariant violated")
  }

  if (commit && opts.assignment !== "shadow") {
    for (const chunk of decisionChunks) {
      await opts.state.appendDecision(chunk)
    }
    const nextDecisions = opts.state.readDecisions()
    if (!nextDecisions.startsWith(previousDecisions)) {
      throw new Error("decisions.md append-only invariant violated")
    }
    await opts.state.saveWatchlist(watchlist)
    await opts.state.saveLedger(ledger)
    if (opts.archiveRoot) {
      for (const item of acceptedForArchive) {
        await archiveAcceptedDecisionBundle({
          archiveRoot: opts.archiveRoot,
          proposal: item.proposal,
          policyVersion: opts.policyVersion,
          assignment: opts.assignment,
          ...(item.gateReceiptId ? { gateReceiptId: item.gateReceiptId } : {}),
        })
      }
    }
  }

  const receiptsBody = `${JSON.stringify({ schema: 1, runId: opts.runId, receipts }, null, 2)}\n`
  const receiptsPath = join(
    opts.agentRoot,
    "reports",
    opts.runId,
    "validation-receipts.json",
  )
  await writeAtomicFile(receiptsPath, receiptsBody)
  if (opts.archiveRoot) {
    const archiveReceipts = join(
      opts.archiveRoot,
      "runs",
      opts.runId,
      "validation-receipts.json",
    )
    await writeAtomicFile(archiveReceipts, receiptsBody)
  }

  return {
    receipts,
    accepted,
    rejected,
    blockedExternal,
    plannedWatchlist: watchlist,
    plannedLedger: ledger,
    plannedDecisions,
    plannedWatchlistHash: sha256Json(watchlist as never),
    committed: commit && opts.assignment !== "shadow",
  }
}

/**
 * exoneration — host-side queue for `warn`-intent rug-dock proposals (INV-S13).
 *
 * A `warn` verdict suspends the immediate score penalty but never exonerates
 * autonomously: the source is provisionally docked, its rug-adjacency counter
 * increments, and a pending proposal is persisted append-only under the host
 * archive (outside the workspace — the agent never sees or influences it) then
 * DMed to the allowlisted operator. Only the operator's confirm/undock are
 * terminal writes to sources.json, funnelled through SourceWriter.
 *
 * All sources.json mutations go through SourceWriter; this module never calls
 * saveSources directly.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { sha256Json } from "../lib/canonical-json.js"
import type { ArchiveLayout } from "../lib/archive.js"
import {
  ExonerationProposalSchema,
  ExonerationsFileSchema,
  type ExonerationProposal,
  type ExonerationsFile,
} from "../contracts/schemas.js"
import type { SourceWriter } from "./sources-write.js"

export type OperatorResolver = "operator-telegram" | "operator-cli"

/** Bound DM sender to an allowlisted chat id chosen by the caller (INV-B3). */
export type OperatorNotifier = Readonly<{
  operatorChatId: string
  sendDm: (chatId: string, text: string) => Promise<void>
  // optional human-readable excerpt for review; stored only as a hash on the proposal
  quotedExcerpt?: string
}>

export function exonerationsPath(layout: ArchiveLayout): string {
  return join(layout.exonerations, "exonerations.json")
}

export function loadExonerations(layout: ArchiveLayout): ExonerationsFile {
  const path = exonerationsPath(layout)
  if (!existsSync(path)) return { schema: 1, proposals: [] }
  return ExonerationsFileSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

async function save(layout: ArchiveLayout, file: ExonerationsFile): Promise<void> {
  await writeAtomicFile(
    exonerationsPath(layout),
    `${JSON.stringify(ExonerationsFileSchema.parse(file), null, 2)}\n`,
  )
}

/** Deterministic id so a retried proposal is idempotent (no double dock/DM). */
export function proposalId(args: Readonly<{
  sourceId: string
  quotedMessageHash: string
  matchedAddress: string
}>): string {
  const hash = sha256Json({
    sourceId: args.sourceId,
    quotedMessageHash: args.quotedMessageHash,
    matchedAddress: args.matchedAddress,
  })
  return `ex-${hash.slice("sha256:".length, "sha256:".length + 16)}`
}

function dmText(proposal: ExonerationProposal, excerpt?: string): string {
  const lines = [
    `trenchcoat exoneration ${proposal.id}`,
    `source ${proposal.provenance}`,
    `flags ${proposal.scannerFlags.join(",") || "none"}`,
    `CA ${proposal.matchedAddress}`,
    "intent verdict warn -> dock suspended pending review",
    `reply: confirm ${proposal.id}  |  undock ${proposal.id}`,
  ]
  if (excerpt) {
    lines.push(`untrusted quoted: ${excerpt.slice(0, 280)}`)
  }
  return lines.join("\n")
}

export type ProposeWarnArgs = Readonly<{
  layout: ArchiveLayout
  writer: SourceWriter
  sourceId: string
  provenance: string
  quotedMessageHash: `sha256:${string}`
  scannerFlags: readonly string[]
  matchedAddress: string
  nowIso: string
  notify?: OperatorNotifier
}>

/**
 * Persist a pending exoneration proposal for a `warn` verdict.
 * Idempotent: an existing proposal with the same deterministic id is returned
 * untouched (no re-dock, no re-increment, no re-DM).
 */
export async function proposeWarn(args: ProposeWarnArgs): Promise<ExonerationProposal> {
  const id = proposalId({
    sourceId: args.sourceId,
    quotedMessageHash: args.quotedMessageHash,
    matchedAddress: args.matchedAddress,
  })
  const file = loadExonerations(args.layout)
  const existing = file.proposals.find((p) => p.id === id)
  if (existing) return existing

  // Provisional dock + adjacency increment; score is left untouched (INV-S13)
  await args.writer.setDocked({
    sourceId: args.sourceId,
    dockReason: "rug-adjacency:warn-suspended",
    incrementRugAdjacency: true,
  })

  const proposal = ExonerationProposalSchema.parse({
    schema: 1,
    id,
    sourceId: args.sourceId,
    provenance: args.provenance,
    quotedMessageHash: args.quotedMessageHash,
    scannerFlags: [...args.scannerFlags],
    matchedAddress: args.matchedAddress,
    proposedAt: args.nowIso,
    status: "pending",
    intentVerdict: "warn",
    dockSuspended: true,
    rugAdjacencyIncremented: true,
  })

  await save(args.layout, { schema: 1, proposals: [...file.proposals, proposal] })

  if (args.notify) {
    await args.notify.sendDm(
      args.notify.operatorChatId,
      dmText(proposal, args.notify.quotedExcerpt),
    )
  }

  return proposal
}

type ResolveArgs = Readonly<{
  layout: ArchiveLayout
  writer: SourceWriter
  id: string
  by: OperatorResolver
  nowIso: string
}>

function findOrThrow(file: ExonerationsFile, id: string): ExonerationProposal {
  const proposal = file.proposals.find((p) => p.id === id)
  if (!proposal) throw new Error(`exoneration: unknown proposal ${id}`)
  return proposal
}

async function transition(
  args: ResolveArgs,
  target: "confirmed" | "undocked",
): Promise<ExonerationProposal> {
  const file = loadExonerations(args.layout)
  const proposal = findOrThrow(file, args.id)

  if (proposal.status === target) return proposal
  if (proposal.status !== "pending") {
    throw new Error(
      `exoneration: ${args.id} already ${proposal.status}, cannot ${target}`,
    )
  }

  if (target === "confirmed") {
    await args.writer.setDocked({ sourceId: proposal.sourceId, dockReason: "rug-shill:confirmed" })
  } else {
    await args.writer.clearDock(proposal.sourceId)
  }

  const resolved = ExonerationProposalSchema.parse({
    ...proposal,
    status: target,
    resolvedAt: args.nowIso,
    resolvedBy: args.by,
  })
  await save(args.layout, {
    schema: 1,
    proposals: file.proposals.map((p) => (p.id === args.id ? resolved : p)),
  })
  return resolved
}

/** Operator confirms the dock stands. Idempotent terminal transition. */
export async function confirm(args: ResolveArgs): Promise<ExonerationProposal> {
  return transition(args, "confirmed")
}

/** Operator exonerates the source. Idempotent terminal transition; clears dock. */
export async function undock(args: ResolveArgs): Promise<ExonerationProposal> {
  return transition(args, "undocked")
}

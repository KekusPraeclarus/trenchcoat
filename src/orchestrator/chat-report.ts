import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join, resolve, sep } from "node:path"
import {
  ChatSummaryFileSchema,
  type BroadcastItem,
  type ChatSummaryFile,
  type ChatSummaryReceipt,
} from "../contracts/schemas.js"
import { runArchiveDir, writeJsonRecordFsync, type ArchiveLayout } from "../lib/archive.js"
import {
  restatesUnchangedNarrativeStage,
  type StageKnown,
} from "./narrative-stage-dedupe.js"
import { buildBroadcastRouterEvent } from "./router.js"
import type { OutboxIngestReport } from "./outbox-ingest.js"

/** Jobs that always get a host-rendered reports/chat/<run-id>.md after terminal success */
export const CHAT_SUMMARY_JOBS = new Set([
  "list-scan",
  "telegram-alpha",
  "narrative-scan",
  "farcaster-scan",
  "review",
  "research",
  "harness-improve",
])

const MAX_CHAT_REPORT_BYTES = 64_000
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

/** agent/reports/<run-id>/chat-summary.json — untrusted operator Q&A context proposal */
export function chatSummaryProposalPath(agentRoot: string, runId: string): string {
  return join(agentRoot, "reports", runId, "chat-summary.json")
}

export function chatReportPath(agentRoot: string, runId: string): string {
  return join(agentRoot, "reports", "chat", `${runId}.md`)
}

/**
 * How much a run matters for operator recall.
 * - `movement`: the run staged a broadcast, accepted a proposal, or moved the
 *   narrative log.
 * - `changed`: nothing moved, but something went differently — degraded
 *   collection, rejects, a typed skip, or a failure.
 * - `routine`: a successful run with no change worth reading.
 */
export type HostChatActivity = "movement" | "changed" | "routine"

export type HostChatFacts = Readonly<{
  job: string
  runStatus: string
  /** Host classification; absent facts default to `routine` at render */
  activity?: HostChatActivity
  /** Detail lines a routine report omits; full detail stays in the archive */
  routineCount?: number
  collectionStatus?: string
  collectionKind?: string
  marketBlind?: boolean
  marketBlindReason?: string
  snapshotNames?: readonly string[]
  postCount?: number
  fypEligible?: number
  platformNotes?: readonly string[]
  proposals?: Readonly<{
    accepted: number
    rejected: number
    blockedExternal?: number
  }>
  narrative?: Readonly<{
    appended?: number
    updated?: number
    purged?: number
  }>
  research?: Readonly<{
    subject?: string
    resolution?: string
    queueId?: string
  }>
  engagement?: Readonly<{
    platform: "x" | "farcaster"
    proposed: number
    accepted: number
    rejected: number
    executed?: number
    verified?: number
    ambiguous?: number
    botHealthBlocked?: boolean
  }>
  harness?: Readonly<{
    status: string
    reason?: string
    reasonSlug?: string
    nextAction?: string
    developmentEpochId?: string
    holdoutEpochId?: string
    hypothesisId?: string
  }>
  ingest?: Readonly<{
    staged: number
    rejected: number
  }>
  broadcasts?: readonly Readonly<{
    severity: string
    text: string
  }>[]
  receiptPaths?: readonly string[]
}>

function resolveUnder(root: string, rel: string): string | undefined {
  const base = resolve(root)
  const full = resolve(base, rel)
  if (full !== base && !full.startsWith(base + sep)) return undefined
  return full
}

function isRegularConfinedFile(agentRoot: string, rel: string): boolean {
  const full = resolveUnder(agentRoot, rel)
  if (!full) return false
  if (!existsSync(full)) return false
  const st = lstatSync(full)
  return st.isFile() && !st.isSymbolicLink()
}

export function stagedBroadcastEventIds(
  runId: string,
  nowIso: string,
  items: readonly BroadcastItem[],
): readonly `sha256:${string}`[] {
  return items.map((item) => {
    const eventId = buildBroadcastRouterEvent(runId, nowIso, item).eventId
    if (!eventId.startsWith("sha256:")) {
      throw new Error("broadcast eventId missing sha256 prefix")
    }
    return eventId as `sha256:${string}`
  })
}

function resolveProposalItemIds(
  proposed: readonly string[],
  stagedIds: readonly `sha256:${string}`[],
): { ok: true; ids: readonly `sha256:${string}`[] } | { ok: false; reason: string } {
  if (proposed.length === 0 && stagedIds.length === 0) {
    return { ok: true, ids: [] }
  }
  if (proposed.length === 0) {
    return { ok: true, ids: stagedIds }
  }
  const resolved: `sha256:${string}`[] = []
  for (const ref of proposed) {
    const indexMatch = /^item:([0-7])$/u.exec(ref)
    if (indexMatch) {
      const idx = Number(indexMatch[1])
      const id = stagedIds[idx]
      if (!id) return { ok: false, reason: "item-index-out-of-range" }
      resolved.push(id)
      continue
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(ref)) return { ok: false, reason: "invalid-item-id" }
    resolved.push(ref as `sha256:${string}`)
  }
  const want = [...new Set(stagedIds)].sort()
  const got = [...new Set(resolved)].sort()
  if (want.length !== got.length || want.some((v, i) => v !== got[i])) {
    return { ok: false, reason: "item-ids-mismatch" }
  }
  return { ok: true, ids: stagedIds }
}

/**
 * Grade one set of host facts. Movement wins over change, and change wins over
 * routine, so an operator never loses a real event to a quiet summary.
 */
export function classifyHostChatActivity(facts: HostChatFacts): HostChatActivity {
  const narrativeMoved = (facts.narrative?.appended ?? 0) > 0
    || (facts.narrative?.updated ?? 0) > 0
  if (
    (facts.ingest?.staged ?? 0) > 0
    || (facts.proposals?.accepted ?? 0) > 0
    || narrativeMoved
    || (facts.engagement?.executed ?? 0) > 0
    || facts.harness?.status === "activation_pending"
  ) {
    return "movement"
  }
  const harnessChanged = facts.harness !== undefined
    && facts.harness.status !== "completed"
  if (
    facts.runStatus === "failed"
    || (facts.collectionStatus !== undefined && facts.collectionStatus !== "completed")
    || facts.marketBlind === true
    || (facts.ingest?.rejected ?? 0) > 0
    || (facts.proposals?.rejected ?? 0) > 0
    || (facts.proposals?.blockedExternal ?? 0) > 0
    || (facts.engagement?.rejected ?? 0) > 0
    || harnessChanged
  ) {
    return "changed"
  }
  return "routine"
}

/** Detail lines a routine report leaves in the archive instead of the report */
function routineOmittedCount(facts: HostChatFacts): number {
  return (facts.snapshotNames?.length ?? 0)
    + (facts.receiptPaths?.length ?? 0)
    + (facts.platformNotes?.length ?? 0)
    + (facts.broadcasts?.length ?? 0)
}

function renderRoutineChatFactsMarkdown(runId: string, facts: HostChatFacts): string {
  const omitted = facts.routineCount ?? routineOmittedCount(facts)
  const parts = [
    `job=${facts.job}`,
    `status=${facts.runStatus}`,
    ...(facts.collectionStatus ? [`collection=${facts.collectionStatus}`] : []),
    ...(facts.postCount !== undefined ? [`posts=${facts.postCount}`] : []),
    `staged=${facts.ingest?.staged ?? 0}`,
    `omittedDetail=${omitted}`,
  ]
  return [
    "# Chat recall",
    "",
    `Run: \`${runId}\``,
    "",
    "## Host summary",
    "",
    `- job: ${facts.job}`,
    `- status: ${facts.runStatus}`,
    "- activity: routine",
    `- summary: routine run, no movement (${parts.join(" ")})`,
    "",
  ].join("\n")
}

function countLine(label: string, value: number | string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined
  return `- ${label}: ${value}`
}

/** Trusted host markdown — never includes agent prose */
export function renderHostChatFactsMarkdown(
  runId: string,
  facts: HostChatFacts,
): string {
  const activity = facts.activity ?? classifyHostChatActivity(facts)
  if (activity === "routine") return renderRoutineChatFactsMarkdown(runId, facts)
  const lines = [
    "# Chat recall",
    "",
    `Run: \`${runId}\``,
    "",
    "## Host summary",
    "",
    `- job: ${facts.job}`,
    `- status: ${facts.runStatus}`,
    `- activity: ${activity}`,
  ]
  const optional = [
    countLine("collection", facts.collectionStatus),
    countLine("collectionKind", facts.collectionKind),
    facts.marketBlind
      ? `- marketBlind: true${facts.marketBlindReason ? ` (${facts.marketBlindReason})` : ""}`
      : undefined,
    countLine("posts", facts.postCount),
    countLine("fypEligible", facts.fypEligible),
    facts.snapshotNames && facts.snapshotNames.length > 0
      ? `- snapshots: ${facts.snapshotNames.slice(0, 24).join(", ")}`
      : undefined,
  ]
  for (const line of optional) {
    if (line) lines.push(line)
  }

  if (facts.platformNotes && facts.platformNotes.length > 0) {
    lines.push("", "### Source freshness / platform coverage", "")
    for (const note of facts.platformNotes.slice(0, 16)) {
      lines.push(`- ${note.slice(0, 280)}`)
    }
  }

  if (facts.research) {
    lines.push("", "### Research", "")
    if (facts.research.subject) lines.push(`- subject: ${facts.research.subject.slice(0, 200)}`)
    if (facts.research.resolution) lines.push(`- resolution: ${facts.research.resolution}`)
    if (facts.research.queueId) lines.push(`- queueId: \`${facts.research.queueId}\``)
  }

  if (facts.proposals) {
    lines.push("", "### Queue / watchlist mutations", "")
    lines.push(`- proposals accepted: ${facts.proposals.accepted}`)
    lines.push(`- proposals rejected: ${facts.proposals.rejected}`)
    if (facts.proposals.blockedExternal !== undefined) {
      lines.push(`- proposals blockedExternal: ${facts.proposals.blockedExternal}`)
    }
  }

  if (facts.narrative) {
    lines.push("", "### Narrative log", "")
    if (facts.narrative.appended !== undefined) {
      lines.push(`- appended: ${facts.narrative.appended}`)
    }
    if (facts.narrative.updated !== undefined) {
      lines.push(`- updated: ${facts.narrative.updated}`)
    }
    if (facts.narrative.purged !== undefined) {
      lines.push(`- purged: ${facts.narrative.purged}`)
    }
  }

  if (facts.engagement) {
    const e = facts.engagement
    lines.push("", `### Engagement (${e.platform})`, "")
    lines.push(`- proposed: ${e.proposed}`)
    lines.push(`- accepted: ${e.accepted}`)
    lines.push(`- rejected: ${e.rejected}`)
    if (e.executed !== undefined) lines.push(`- executed: ${e.executed}`)
    if (e.verified !== undefined) lines.push(`- verified: ${e.verified}`)
    if (e.ambiguous !== undefined) lines.push(`- ambiguous: ${e.ambiguous}`)
    if (e.botHealthBlocked) lines.push("- botHealthBlocked: true")
  }

  if (facts.harness) {
    const h = facts.harness
    lines.push("", "### Harness improvement", "")
    lines.push(`- harnessStatus: ${h.status}`)
    if (h.status === "skipped") {
      lines.push("- outcome: deferred (typed readiness skip, not a successful proposal)")
    } else if (h.status === "rejected" || h.status === "failed") {
      lines.push(`- outcome: ${h.status}`)
    } else if (h.status === "activation_pending") {
      lines.push("- outcome: activation pending (agent sync + canary not started)")
    }
    if (h.reasonSlug) lines.push(`- reasonSlug: ${h.reasonSlug}`)
    if (h.reason) lines.push(`- reason: ${h.reason.slice(0, 280)}`)
    if (h.developmentEpochId) lines.push(`- developmentEpochId: \`${h.developmentEpochId}\``)
    if (h.holdoutEpochId) lines.push(`- holdoutEpochId: \`${h.holdoutEpochId}\``)
    if (h.hypothesisId) lines.push(`- hypothesisId: \`${h.hypothesisId}\``)
    if (h.nextAction) lines.push(`- nextAction: ${h.nextAction.slice(0, 280)}`)
  }

  if (facts.ingest || (facts.broadcasts && facts.broadcasts.length > 0)) {
    lines.push("", "## Staged broadcasts", "")
    if (facts.ingest) {
      lines.push(`- staged: ${facts.ingest.staged}`)
      lines.push(`- rejected: ${facts.ingest.rejected}`)
      lines.push("")
    }
    if (facts.broadcasts && facts.broadcasts.length > 0) {
      for (const item of facts.broadcasts) {
        lines.push(`**${item.severity}** — ${item.text}`, "")
      }
    } else {
      lines.push("_none_", "")
    }
  }

  if (facts.receiptPaths && facts.receiptPaths.length > 0) {
    lines.push("## Receipt paths", "")
    for (const path of facts.receiptPaths.slice(0, 24)) {
      lines.push(`- \`${path}\``)
    }
    lines.push("")
  }

  return lines.join("\n")
}

function renderAgentContextMarkdown(
  context: readonly string[],
  sources: readonly string[],
): string {
  const lines = [
    "## Agent context (untrusted evidence)",
    "",
    ...context.map((bullet) => `- ${bullet}`),
    "",
    "### Sources",
    "",
  ]
  for (const source of sources) {
    lines.push(`- \`${source}\``)
  }
  lines.push("")
  return lines.join("\n")
}

/** Drop chat-summary bullets that restate known narrative heat. */
export function filterStatusQuoContextBullets(
  context: readonly string[],
  statusQuo: readonly StageKnown[],
): string[] {
  if (statusQuo.length === 0) return [...context]
  return context.filter((bullet) => !restatesUnchangedNarrativeStage(bullet, statusQuo))
}

function engagementFromUnknown(
  report: unknown,
  platform: "x" | "farcaster",
): HostChatFacts["engagement"] | undefined {
  if (!report || typeof report !== "object") return undefined
  const r = report as Record<string, unknown>
  const num = (k: string): number | undefined => (
    typeof r[k] === "number" && Number.isFinite(r[k]) ? Math.floor(r[k] as number) : undefined
  )
  const proposed = num("proposed")
  const accepted = num("accepted")
  const rejected = num("rejected")
  if (proposed === undefined || accepted === undefined || rejected === undefined) return undefined
  const executed = num("executed")
  const verified = num("verified")
  const ambiguous = num("ambiguous")
  return {
    platform,
    proposed,
    accepted,
    rejected,
    ...(executed !== undefined ? { executed } : {}),
    ...(verified !== undefined ? { verified } : {}),
    ...(ambiguous !== undefined ? { ambiguous } : {}),
    ...(r["botHealthBlocked"] === true ? { botHealthBlocked: true as const } : {}),
  }
}

/**
 * Build trusted host facts for a recall job from in-scope run state.
 * Safe to call with partial inputs; missing pieces are omitted from markdown.
 */
export function buildHostChatFacts(args: Readonly<{
  job: string
  runStatus?: string
  collection?: Readonly<{
    collectionStatus?: string
    collectionKind?: string
    marketBlind?: boolean
    marketBlindReason?: string
    snapshotNames?: readonly string[]
    postCount?: number
    fypPosts?: readonly unknown[]
    fypCasts?: readonly unknown[]
    researchResolution?: string
  }>
  researchDue?: Readonly<{ subject: string; queueId?: string }>
  proposals?: Readonly<{ accepted: number; rejected: number; blockedExternal?: number }>
  narrativeLogReport?: unknown
  engagementReport?: unknown
  fcEngagementReport?: unknown
  harnessReport?: unknown
  ingest?: OutboxIngestReport
  platformNotes?: readonly string[]
  receiptPaths?: readonly string[]
}>): HostChatFacts {
  const collection = args.collection
  const narrative = (() => {
    if (!args.narrativeLogReport || typeof args.narrativeLogReport !== "object") return undefined
    const n = args.narrativeLogReport as Record<string, unknown>
    const num = (k: string) => (
      typeof n[k] === "number" && Number.isFinite(n[k]) ? Math.floor(n[k] as number) : undefined
    )
    const appended = num("appended") ?? num("added")
    const updated = num("updated")
    const purged = num("purged")
    if (appended === undefined && updated === undefined && purged === undefined) return undefined
    return {
      ...(appended !== undefined ? { appended } : {}),
      ...(updated !== undefined ? { updated } : {}),
      ...(purged !== undefined ? { purged } : {}),
    }
  })()

  const engagement = engagementFromUnknown(args.engagementReport, "x")
    ?? engagementFromUnknown(args.fcEngagementReport, "farcaster")

  const harness = (() => {
    if (!args.harnessReport || typeof args.harnessReport !== "object") return undefined
    const h = args.harnessReport as Record<string, unknown>
    if (typeof h["status"] !== "string") return undefined
    return {
      status: h["status"],
      ...(typeof h["reason"] === "string" ? { reason: h["reason"].slice(0, 280) } : {}),
      ...(typeof h["reasonSlug"] === "string"
        ? { reasonSlug: h["reasonSlug"].slice(0, 64) }
        : {}),
      ...(typeof h["nextAction"] === "string"
        ? { nextAction: h["nextAction"].slice(0, 280) }
        : {}),
      ...(typeof h["developmentEpochId"] === "string"
        ? { developmentEpochId: h["developmentEpochId"].slice(0, 128) }
        : {}),
      ...(typeof h["holdoutEpochId"] === "string"
        ? { holdoutEpochId: h["holdoutEpochId"].slice(0, 128) }
        : {}),
      ...(typeof h["hypothesisId"] === "string"
        ? { hypothesisId: h["hypothesisId"].slice(0, 128) }
        : {}),
    }
  })()

  const fypEligible = collection?.fypPosts?.length
    ?? collection?.fypCasts?.length

  const base: HostChatFacts = {
    job: args.job,
    runStatus: args.runStatus ?? "complete",
    ...(collection?.collectionStatus ? { collectionStatus: collection.collectionStatus } : {}),
    ...(collection?.collectionKind ? { collectionKind: collection.collectionKind } : {}),
    ...(collection?.marketBlind ? {
      marketBlind: true,
      ...(collection.marketBlindReason ? { marketBlindReason: collection.marketBlindReason } : {}),
    } : {}),
    ...(collection?.snapshotNames ? { snapshotNames: collection.snapshotNames } : {}),
    ...(collection?.postCount !== undefined ? { postCount: collection.postCount } : {}),
    ...(fypEligible !== undefined ? { fypEligible } : {}),
    ...(args.platformNotes && args.platformNotes.length > 0
      ? { platformNotes: args.platformNotes }
      : {}),
    ...(args.proposals ? { proposals: args.proposals } : {}),
    ...(narrative ? { narrative } : {}),
    ...(args.researchDue || collection?.researchResolution
      ? {
        research: {
          ...(args.researchDue?.subject ? { subject: args.researchDue.subject } : {}),
          ...(args.researchDue?.queueId ? { queueId: args.researchDue.queueId } : {}),
          ...(collection?.researchResolution
            ? { resolution: collection.researchResolution }
            : {}),
        },
      }
      : {}),
    ...(engagement ? { engagement } : {}),
    ...(harness ? { harness } : {}),
    ...(args.ingest
      ? {
        ingest: { staged: args.ingest.staged, rejected: args.ingest.rejected },
        broadcasts: args.ingest.items.map((item) => ({
          severity: item.severity,
          text: item.text,
        })),
      }
      : {}),
    ...(args.receiptPaths && args.receiptPaths.length > 0
      ? { receiptPaths: args.receiptPaths }
      : {}),
  }
  const activity = classifyHostChatActivity(base)
  return {
    ...base,
    activity,
    ...(activity === "routine" ? { routineCount: routineOmittedCount(base) } : {}),
  }
}

function readProposalFile(args: Readonly<{
  agentRoot: string
  runId: string
  stagedIds: readonly `sha256:${string}`[]
}>): Readonly<{
  accepted: true
  data: ChatSummaryFile
  itemIds: readonly `sha256:${string}`[]
} | {
  accepted: false
  reason: string
}> {
  const proposalPath = chatSummaryProposalPath(args.agentRoot, args.runId)
  if (!existsSync(proposalPath)) {
    return { accepted: false, reason: "proposal-missing" }
  }
  const proposalStat = lstatSync(proposalPath)
  if (!proposalStat.isFile() || proposalStat.isSymbolicLink()) {
    return { accepted: false, reason: "proposal-not-regular-file" }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(proposalPath, "utf8"))
  } catch {
    return { accepted: false, reason: "proposal-invalid-json" }
  }
  const validated = ChatSummaryFileSchema.safeParse(parsed)
  if (!validated.success || validated.data.runId !== args.runId) {
    return { accepted: false, reason: "proposal-schema-mismatch" }
  }
  if (validated.data.itemIds.length > 0 && args.stagedIds.length === 0) {
    return { accepted: false, reason: "item-ids-without-broadcasts" }
  }
  const resolvedIds = resolveProposalItemIds(validated.data.itemIds, args.stagedIds)
  if (!resolvedIds.ok) {
    return { accepted: false, reason: resolvedIds.reason }
  }
  for (const source of validated.data.sources) {
    if (!isRegularConfinedFile(args.agentRoot, source)) {
      return { accepted: false, reason: "source-path-invalid" }
    }
  }
  return { accepted: true, data: validated.data, itemIds: resolvedIds.ids }
}

/**
 * Host-render reports/chat/<run-id>.md from trusted facts first. Optional agent
 * chat-summary.json context is appended when valid; missing/malformed proposals
 * never suppress the host summary.
 */
export async function validateAndPromoteChatReport(args: Readonly<{
  agentRoot: string
  layout: ArchiveLayout
  runId: string
  nowIso: string
  ingest: OutboxIngestReport
  facts: HostChatFacts
  blockPromotion?: boolean
  maxReportBytes?: number
  /** Narratives at unchanged heat — stripped from agent context bullets */
  unchangedStages?: readonly StageKnown[]
}>): Promise<ChatSummaryReceipt> {
  const runDir = runArchiveDir(args.layout, args.runId)
  const receiptPath = join(runDir, "chat-summary-receipt.json")
  const stagedIds = stagedBroadcastEventIds(args.runId, args.nowIso, args.ingest.items)
  const reportRel = `reports/chat/${args.runId}.md`
  const maxBytes = args.maxReportBytes ?? MAX_CHAT_REPORT_BYTES

  const writeReceipt = async (receipt: ChatSummaryReceipt): Promise<ChatSummaryReceipt> => {
    await writeJsonRecordFsync(
      receiptPath,
      JSON.parse(JSON.stringify(receipt)) as import("../lib/canonical-json.js").JsonValue,
    )
    return receipt
  }

  const bypassPath = chatReportPath(args.agentRoot, args.runId)
  if (existsSync(bypassPath)) {
    rmSync(bypassPath, { force: true })
  }

  if (args.blockPromotion) {
    return writeReceipt({
      schema: 1,
      runId: args.runId,
      validatedAt: args.nowIso,
      promoted: false,
      reason: "promotion-blocked",
      itemIds: [...stagedIds],
      untrustedEvidence: true,
    })
  }

  const merged: HostChatFacts = {
    ...args.facts,
    ingest: { staged: args.ingest.staged, rejected: args.ingest.rejected },
    broadcasts: args.ingest.items.map((item) => ({
      severity: item.severity,
      text: item.text,
    })),
    receiptPaths: [
      ...(args.facts.receiptPaths ?? []),
      `archive/runs/${args.runId}/chat-summary-receipt.json`,
      reportRel,
    ].filter((v, i, arr) => arr.indexOf(v) === i),
  }
  // Reclassify: staged broadcasts arrive after buildHostChatFacts
  const activity = classifyHostChatActivity(merged)
  const facts: HostChatFacts = {
    ...merged,
    activity,
    ...(activity === "routine" ? { routineCount: routineOmittedCount(merged) } : {}),
  }

  const hostMd = renderHostChatFactsMarkdown(args.runId, facts)
  const proposal = readProposalFile({
    agentRoot: args.agentRoot,
    runId: args.runId,
    stagedIds,
  })

  let text = hostMd
  let proposalAccepted = false
  let proposalReason: string | undefined
  let itemIds: readonly `sha256:${string}`[] = stagedIds
  let acceptedProposal: ChatSummaryFile | undefined

  if (proposal.accepted) {
    // Strip status-quo heat restatements from rendered context; archive keeps the proposal
    // A routine run renders no agent context at all — the receipt keeps it
    const filteredContext = activity === "routine"
      ? []
      : filterStatusQuoContextBullets(
        proposal.data.context,
        args.unchangedStages ?? [],
      )
    const agentMd = filteredContext.length > 0
      ? renderAgentContextMarkdown(filteredContext, proposal.data.sources)
      : ""
    const combined = agentMd.length > 0 ? `${hostMd}\n${agentMd}` : hostMd
    if (Buffer.byteLength(combined) <= maxBytes) {
      text = combined
      proposalAccepted = true
      itemIds = proposal.itemIds
      acceptedProposal = proposal.data
    } else if (Buffer.byteLength(hostMd) <= maxBytes) {
      text = hostMd
      proposalReason = "report-too-large"
    } else {
      return writeReceipt({
        schema: 1,
        runId: args.runId,
        validatedAt: args.nowIso,
        promoted: false,
        reason: "report-too-large",
        proposalAccepted: false,
        proposalReason: "report-too-large",
        itemIds: [...stagedIds],
        untrustedEvidence: true,
      })
    }
  } else {
    proposalReason = proposal.reason
    if (Buffer.byteLength(hostMd) > maxBytes) {
      return writeReceipt({
        schema: 1,
        runId: args.runId,
        validatedAt: args.nowIso,
        promoted: false,
        reason: "report-too-large",
        proposalAccepted: false,
        proposalReason,
        itemIds: [...stagedIds],
        untrustedEvidence: true,
      })
    }
  }

  mkdirSync(join(args.agentRoot, "reports", "chat"), { recursive: true })
  writeFileSync(chatReportPath(args.agentRoot, args.runId), text)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, "chat-report.md"), text)
  if (acceptedProposal) {
    await writeJsonRecordFsync(join(runDir, "chat-summary-proposal.json"), acceptedProposal)
  }

  return writeReceipt({
    schema: 1,
    runId: args.runId,
    validatedAt: args.nowIso,
    promoted: true,
    ...(proposalReason ? { proposalReason } : {}),
    proposalAccepted,
    hostOnly: !proposalAccepted,
    itemIds: [...itemIds],
    reportPath: reportRel,
    untrustedEvidence: true,
  })
}

/**
 * Chat recall is promoted mid-run (after alpha purge) while journal.status is
 * still `running`. Once the run reaches a terminal status, rewrite the host
 * summary status line in both agent + archive copies. Does not touch agent
 * context bullets or ADR 006 seal-time journals.
 */
export function finalizeChatReportRunStatus(args: Readonly<{
  agentRoot: string
  layout: ArchiveLayout
  runId: string
  runStatus: "complete" | "failed"
}>): boolean {
  const statusLine = /^- status: .+$/mu
  let touched = false
  const paths = [
    join(runArchiveDir(args.layout, args.runId), "chat-report.md"),
    chatReportPath(args.agentRoot, args.runId),
  ]
  for (const path of paths) {
    if (!existsSync(path)) continue
    let raw: string
    try {
      raw = readFileSync(path, "utf8")
    } catch {
      continue
    }
    if (!statusLine.test(raw)) continue
    const next = raw.replace(statusLine, `- status: ${args.runStatus}`)
    if (next === raw) continue
    writeFileSync(path, next)
    touched = true
  }
  return touched
}

/**
 * User-facing research body: drop host/agent chrome the model often adds.
 * Host facts stay in research-chat-receipt.json, not in the delivered report.
 */
export function sanitizeResearchChatBody(text: string): string {
  const out: string[] = []
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim()
    if (/^#{0,3}\s*Chat recall\b/iu.test(trimmed)) continue
    if (/^#{0,3}\s*Host summary\b/iu.test(trimmed)) continue
    if (/^#{0,3}\s*Agent context\b/iu.test(trimmed)) continue
    if (/^#{0,3}\s*Receipt paths\b/iu.test(trimmed)) continue
    if (/^#{0,3}\s*Sources\b/iu.test(trimmed) && out.length === 0) continue
    // Meta line: "SOL (So111…) · run discord-research-… · 19 Jul 2026"
    if (/·\s*run\s+\S+/iu.test(raw)) continue
    // Sample-size / engagement chrome — chat replies stay summarative
    if (/bounded host search sample/iu.test(trimmed)) continue
    if (/not platform-wide reach/iu.test(trimmed)) continue
    if (/may reflect search bounds/iu.test(trimmed)) continue
    if (/^\*?\*?[\d,]+\s+posts\b/iu.test(trimmed)) continue
    if (/^\|?\s*Engagement\b/iu.test(trimmed)) continue
    if (/^\|?\s*Likes\s*\|/iu.test(trimmed)) continue
    if (/^\|?\s*Views\s*\|/iu.test(trimmed)) continue
    if (/^\|?\s*Replies\s*\|/iu.test(trimmed)) continue
    if (/^\|?\s*Reposts\s*\|/iu.test(trimmed)) continue
    if (/^\|?\s*Median likes/iu.test(trimmed)) continue
    if (/^\|?\s*:?-{3,}\s*\|/u.test(trimmed)) continue

    const line = raw
      .replace(/\s*[—–-]\s*chat summary\b/giu, "")
      .replace(/\s*\(untrusted(?:\s+evidence)?\)/giu, "")
    out.push(line)
  }
  return `${out.join("\n").replace(/\n{3,}/gu, "\n\n").trim()}\n`
}

function renderResearchChatMarkdown(args: Readonly<{
  runId: string
  subject: string
  body?: string
  facts?: HostChatFacts
}>): string {
  void args.runId
  void args.facts
  if (args.body?.trim()) return sanitizeResearchChatBody(args.body)
  return `# Research\n\nSubject: ${args.subject}\n`
}

/**
 * Host-promote a research chat summary into reports/chat/<run-id>.md.
 * Writes the sanitized chat-facing body (or a minimal subject stub). Host facts
 * live in research-chat-receipt.json — not in the delivered markdown.
 */
export async function promoteResearchChatReport(args: Readonly<{
  agentRoot: string
  layout: ArchiveLayout
  runId: string
  nowIso: string
  subject: string
  facts?: HostChatFacts
  maxReportBytes?: number
}>): Promise<Readonly<{
  promoted: boolean
  reportPath: string
  hostOnly?: boolean
  proposalReason?: string
}>> {
  const reportRel = `reports/chat/${args.runId}.md`
  const empty = { promoted: false as const, reportPath: reportRel }
  if (!SAFE_RUN_ID.test(args.runId)) return empty

  const bypass = chatReportPath(args.agentRoot, args.runId)
  if (existsSync(bypass)) {
    rmSync(bypass, { force: true })
  }

  const maxBytes = args.maxReportBytes ?? MAX_CHAT_REPORT_BYTES
  const candidates = [
    `reports/${args.runId}/chat-summary.md`,
    `reports/${args.runId}/chat-summary.json`,
  ] as const

  let body: string | undefined
  let proposalReason: string | undefined
  let sourceRel: string | undefined
  for (const rel of candidates) {
    if (!isRegularConfinedFile(args.agentRoot, rel)) continue
    const full = resolveUnder(args.agentRoot, rel)
    if (!full) continue
    if (lstatSync(full).size > maxBytes) {
      proposalReason = "proposal-too-large"
      continue
    }
    sourceRel = rel
    break
  }

  if (sourceRel) {
    const sourcePath = resolveUnder(args.agentRoot, sourceRel)!
    try {
      const raw = readFileSync(sourcePath, "utf8")
      if (sourceRel.endsWith(".json")) {
        const parsed = JSON.parse(raw) as unknown
        if (
          parsed
          && typeof parsed === "object"
          && !Array.isArray(parsed)
          && typeof (parsed as { text?: unknown }).text === "string"
        ) {
          body = (parsed as { text: string }).text
        } else if (
          parsed
          && typeof parsed === "object"
          && !Array.isArray(parsed)
          && Array.isArray((parsed as { context?: unknown }).context)
        ) {
          body = ((parsed as { context: unknown[] }).context)
            .filter((line): line is string => typeof line === "string")
            .map((line) => `- ${line.slice(0, 280)}`)
            .join("\n")
        } else {
          proposalReason = "proposal-schema-mismatch"
        }
      } else {
        body = raw
      }
    } catch {
      proposalReason = "proposal-invalid"
      body = undefined
    }
  } else if (!proposalReason) {
    proposalReason = "proposal-missing"
  }

  const subject = args.subject.trim().slice(0, 200)
  if (!subject) return empty

  const withBody = renderResearchChatMarkdown({
    runId: args.runId,
    subject,
    ...(body?.trim() ? { body: body.slice(0, maxBytes) } : {}),
    ...(args.facts ? { facts: args.facts } : {}),
  })
  const hostOnly = renderResearchChatMarkdown({
    runId: args.runId,
    subject,
    ...(args.facts ? { facts: args.facts } : {}),
  })

  let text = withBody
  let hostOnlyFlag = !body?.trim()
  if (Buffer.byteLength(withBody) > maxBytes) {
    if (Buffer.byteLength(hostOnly) > maxBytes) return empty
    text = hostOnly
    hostOnlyFlag = true
    proposalReason = proposalReason ?? "report-too-large"
  }

  mkdirSync(join(args.agentRoot, "reports", "chat"), { recursive: true })
  writeFileSync(chatReportPath(args.agentRoot, args.runId), text)
  const runDir = runArchiveDir(args.layout, args.runId)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, "chat-report.md"), text)
  await writeJsonRecordFsync(join(runDir, "research-chat-receipt.json"), {
    schema: 1,
    runId: args.runId,
    promotedAt: args.nowIso,
    promoted: true,
    reportPath: reportRel,
    subject,
    hostOnly: hostOnlyFlag,
    ...(proposalReason ? { proposalReason } : {}),
    untrustedEvidence: true,
  })
  return {
    promoted: true,
    reportPath: reportRel,
    hostOnly: hostOnlyFlag,
    ...(proposalReason ? { proposalReason } : {}),
  }
}

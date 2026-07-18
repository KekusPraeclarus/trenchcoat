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
  type ChatSummaryReceipt,
} from "../contracts/schemas.js"
import { runArchiveDir, writeJsonRecordFsync, type ArchiveLayout } from "../lib/archive.js"
import { buildBroadcastRouterEvent } from "./router.js"
import type { OutboxIngestReport } from "./outbox-ingest.js"

export const CHAT_SUMMARY_JOBS = new Set(["list-scan", "narrative-scan"])

const MAX_CHAT_REPORT_BYTES = 64_000

/** agent/reports/<run-id>/chat-summary.json — untrusted operator Q&A context proposal */
export function chatSummaryProposalPath(agentRoot: string, runId: string): string {
  return join(agentRoot, "reports", runId, "chat-summary.json")
}

export function chatReportPath(agentRoot: string, runId: string): string {
  return join(agentRoot, "reports", "chat", `${runId}.md`)
}

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

function rejectReceipt(args: Readonly<{
  runId: string
  nowIso: string
  reason: string
  itemIds?: readonly `sha256:${string}`[]
}>): ChatSummaryReceipt {
  return {
    schema: 1,
    runId: args.runId,
    validatedAt: args.nowIso,
    promoted: false,
    reason: args.reason,
    itemIds: args.itemIds ? [...args.itemIds] : [],
    untrustedEvidence: true,
  }
}

function renderChatReportMarkdown(
  runId: string,
  items: readonly BroadcastItem[],
  context: readonly string[],
  sources: readonly string[],
): string {
  const lines = [
    "# Chat summary",
    "",
    `Run: \`${runId}\``,
    "",
    "## Broadcast",
    "",
  ]
  for (const item of items) {
    lines.push(`**${item.severity}** — ${item.text}`, "")
  }
  lines.push("## Context", "", ...context.map((bullet) => `- ${bullet}`), "", "## Sources (untrusted evidence)", "")
  for (const source of sources) {
    lines.push(`- \`${source}\``)
  }
  lines.push("")
  return lines.join("\n")
}

/**
 * Validate the agent's chat-summary proposal against staged broadcasts and, when
 * accepted, host-render reports/chat/<run-id>.md. Missing or invalid proposals
 * are non-fatal but archived with an explicit reject reason.
 */
export async function validateAndPromoteChatReport(args: Readonly<{
  agentRoot: string
  layout: ArchiveLayout
  runId: string
  nowIso: string
  ingest: OutboxIngestReport
  blockPromotion?: boolean
  maxReportBytes?: number
}>): Promise<ChatSummaryReceipt> {
  const runDir = runArchiveDir(args.layout, args.runId)
  const receiptPath = join(runDir, "chat-summary-receipt.json")
  const stagedIds = stagedBroadcastEventIds(args.runId, args.nowIso, args.ingest.items)

  const writeReceipt = async (receipt: ChatSummaryReceipt): Promise<ChatSummaryReceipt> => {
    await writeJsonRecordFsync(
      receiptPath,
      JSON.parse(JSON.stringify(receipt)) as import("../lib/canonical-json.js").JsonValue,
    )
    return receipt
  }

  if (args.ingest.staged === 0) {
    return writeReceipt(rejectReceipt({
      runId: args.runId,
      nowIso: args.nowIso,
      reason: "no-staged-broadcasts",
    }))
  }

  const bypassPath = chatReportPath(args.agentRoot, args.runId)
  if (existsSync(bypassPath)) {
    rmSync(bypassPath, { force: true })
  }

  if (args.blockPromotion) {
    return writeReceipt(rejectReceipt({
      runId: args.runId,
      nowIso: args.nowIso,
      reason: "promotion-blocked",
      itemIds: stagedIds,
    }))
  }

  const proposalPath = chatSummaryProposalPath(args.agentRoot, args.runId)
  if (!existsSync(proposalPath)) {
    return writeReceipt(rejectReceipt({
      runId: args.runId,
      nowIso: args.nowIso,
      reason: "proposal-missing",
      itemIds: stagedIds,
    }))
  }

  const proposalStat = lstatSync(proposalPath)
  if (!proposalStat.isFile() || proposalStat.isSymbolicLink()) {
    return writeReceipt(rejectReceipt({
      runId: args.runId,
      nowIso: args.nowIso,
      reason: "proposal-not-regular-file",
      itemIds: stagedIds,
    }))
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(proposalPath, "utf8"))
  } catch {
    return writeReceipt(rejectReceipt({
      runId: args.runId,
      nowIso: args.nowIso,
      reason: "proposal-invalid-json",
      itemIds: stagedIds,
    }))
  }

  const validated = ChatSummaryFileSchema.safeParse(parsed)
  if (!validated.success || validated.data.runId !== args.runId) {
    return writeReceipt(rejectReceipt({
      runId: args.runId,
      nowIso: args.nowIso,
      reason: "proposal-schema-mismatch",
      itemIds: stagedIds,
    }))
  }

  const resolvedIds = resolveProposalItemIds(validated.data.itemIds, stagedIds)
  if (!resolvedIds.ok) {
    return writeReceipt(rejectReceipt({
      runId: args.runId,
      nowIso: args.nowIso,
      reason: resolvedIds.reason,
      itemIds: stagedIds,
    }))
  }

  for (const source of validated.data.sources) {
    if (!isRegularConfinedFile(args.agentRoot, source)) {
      return writeReceipt(rejectReceipt({
        runId: args.runId,
        nowIso: args.nowIso,
        reason: "source-path-invalid",
        itemIds: stagedIds,
      }))
    }
  }

  const text = renderChatReportMarkdown(
    args.runId,
    args.ingest.items,
    validated.data.context,
    validated.data.sources,
  )
  if (Buffer.byteLength(text) > (args.maxReportBytes ?? MAX_CHAT_REPORT_BYTES)) {
    return writeReceipt(rejectReceipt({
      runId: args.runId,
      nowIso: args.nowIso,
      reason: "report-too-large",
      itemIds: stagedIds,
    }))
  }

  const reportRel = `reports/chat/${args.runId}.md`
  mkdirSync(join(args.agentRoot, "reports", "chat"), { recursive: true })
  writeFileSync(chatReportPath(args.agentRoot, args.runId), text)
  writeFileSync(join(runDir, "chat-report.md"), text)
  await writeJsonRecordFsync(join(runDir, "chat-summary-proposal.json"), validated.data)

  const receipt: ChatSummaryReceipt = {
    schema: 1,
    runId: args.runId,
    validatedAt: args.nowIso,
    promoted: true,
    itemIds: [...resolvedIds.ids],
    reportPath: reportRel,
    untrustedEvidence: true,
  }
  return writeReceipt(receipt)
}

const MAX_RESEARCH_CHAT_BYTES = 64_000
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

function renderResearchChatMarkdown(args: Readonly<{
  runId: string
  subject: string
  body: string
}>): string {
  return [
    "# Research chat summary",
    "",
    `Run: \`${args.runId}\``,
    `Subject: ${args.subject}`,
    "",
    args.body.trim(),
    "",
  ].join("\n")
}

/**
 * Host-promote a research chat summary proposal into reports/chat/<run-id>.md.
 * Accepts bounded chat-summary.md or chat-summary.json under the run report dir.
 */
export async function promoteResearchChatReport(args: Readonly<{
  agentRoot: string
  layout: ArchiveLayout
  runId: string
  nowIso: string
  subject: string
  maxReportBytes?: number
}>): Promise<Readonly<{ promoted: boolean; reportPath: string }>> {
  const reportRel = `reports/chat/${args.runId}.md`
  const empty = { promoted: false as const, reportPath: reportRel }
  if (!SAFE_RUN_ID.test(args.runId)) return empty

  const bypass = chatReportPath(args.agentRoot, args.runId)
  if (existsSync(bypass)) {
    rmSync(bypass, { force: true })
  }

  const maxBytes = args.maxReportBytes ?? MAX_RESEARCH_CHAT_BYTES
  const candidates = [
    `reports/${args.runId}/chat-summary.md`,
    `reports/${args.runId}/chat-summary.json`,
  ] as const

  let sourceRel: string | undefined
  for (const rel of candidates) {
    if (!isRegularConfinedFile(args.agentRoot, rel)) continue
    const full = resolveUnder(args.agentRoot, rel)
    if (!full) continue
    if (lstatSync(full).size > maxBytes) continue
    sourceRel = rel
    break
  }
  if (!sourceRel) return empty

  const sourcePath = resolveUnder(args.agentRoot, sourceRel)!
  let body: string
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
        return empty
      }
    } else {
      body = raw
    }
  } catch {
    return empty
  }

  const subject = args.subject.trim().slice(0, 200)
  if (!subject || !body.trim()) return empty

  const text = renderResearchChatMarkdown({
    runId: args.runId,
    subject,
    body: body.slice(0, maxBytes),
  })
  if (Buffer.byteLength(text) > maxBytes) return empty

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
    untrustedEvidence: true,
  })
  return { promoted: true, reportPath: reportRel }
}

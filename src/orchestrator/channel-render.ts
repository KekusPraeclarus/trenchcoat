import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ArchiveLayout } from "../lib/archive.js"
import { runArchiveDir, writeJsonRecordFsync } from "../lib/archive.js"
import { sha256Json } from "../lib/canonical-json.js"
import { Outbox } from "../lib/outbox.js"
import type {
  AuditClaim,
  ChatSummaryReceipt,
  DeliveryReceipt,
  RouterChannelPayloads,
  RouterEvent,
} from "../contracts/schemas.js"
import { chatReportPath } from "./chat-report.js"
import {
  runDiscordDistiller,
  type DistillSessionRunner,
} from "./distill-session.js"

const TERMINAL: ReadonlySet<DeliveryReceipt["status"]> = new Set([
  "accepted",
  "duplicate",
  "conflict",
])

export type ChannelRenderReceipt = Readonly<{
  schema: 1
  runId: string
  eventId: `sha256:${string}`
  renderedAt: string
  telegram: "report" | "broadcast-text"
  discord: "distilled" | "broadcast-text"
  distillReason?: string
  inputHash?: `sha256:${string}`
}>

function loadDeliveryReceipts(layout: ArchiveLayout, runId: string): Map<string, DeliveryReceipt> {
  const path = join(runArchiveDir(layout, runId), "delivery-receipts.json")
  const map = new Map<string, DeliveryReceipt>()
  if (!existsSync(path)) return map
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { receipts?: DeliveryReceipt[] }
    for (const receipt of parsed.receipts ?? []) map.set(receipt.eventId, receipt)
  } catch {
    // Corrupt journal ignored; render re-derives from staged outbox.
  }
  return map
}

function readPromotedReport(args: Readonly<{
  agentRoot: string
  layout: ArchiveLayout
  runId: string
  chatSummary?: ChatSummaryReceipt
}>): string | undefined {
  if (!args.chatSummary?.promoted) return undefined
  const workspace = chatReportPath(args.agentRoot, args.runId)
  if (existsSync(workspace)) {
    try {
      const text = readFileSync(workspace, "utf8").trim()
      if (text.length > 0) return text
    } catch {
      // fall through to archive copy
    }
  }
  const archived = join(runArchiveDir(args.layout, args.runId), "chat-report.md")
  if (!existsSync(archived)) return undefined
  try {
    const text = readFileSync(archived, "utf8").trim()
    return text.length > 0 ? text : undefined
  } catch {
    return undefined
  }
}

/**
 * Enrich staged finding.broadcast events with per-channel payloads before HMAC
 * delivery. Idempotent: skips events that already have channels or a terminal
 * delivery receipt. wallet.lifecycle is never enriched (INV-S20).
 */
export async function renderChannelPayloads(args: Readonly<{
  agentRoot: string
  layout: ArchiveLayout
  runId: string
  nowIso: string
  chatSummary?: ChatSummaryReceipt
  distiller: Readonly<{
    enabled: boolean
    dailyCap: number
    usedToday: number
    runSession?: DistillSessionRunner
  }>
}>): Promise<Readonly<{
  rendered: number
  skipped: number
  usedDistill: number
  distillUsedToday: number
  receipts: readonly ChannelRenderReceipt[]
}>> {
  const outbox = new Outbox(join(args.layout.routerOutbox, args.runId))
  const events = outbox.list()
  const deliveries = loadDeliveryReceipts(args.layout, args.runId)
  const reportText = readPromotedReport(args)
  const receipts: ChannelRenderReceipt[] = []
  let rendered = 0
  let skipped = 0
  let usedToday = args.distiller.usedToday
  let usedDistill = 0

  for (const event of events) {
    if (event.type !== "finding.broadcast") {
      skipped += 1
      continue
    }
    if (event.channels) {
      skipped += 1
      continue
    }
    const prior = deliveries.get(event.eventId)
    if (prior && TERMINAL.has(prior.status)) {
      skipped += 1
      continue
    }

    const channels: RouterChannelPayloads = {}
    let telegramSource: ChannelRenderReceipt["telegram"] = "broadcast-text"
    let discordSource: ChannelRenderReceipt["discord"] = "broadcast-text"
    let distillReason: string | undefined
    let inputHash: `sha256:${string}` | undefined

    if (reportText) {
      channels.telegram = { text: reportText.slice(0, 64_000) }
      telegramSource = "report"

      if (args.distiller.enabled) {
        inputHash = sha256Json({
          report: reportText,
          claim: event.auditClaim ?? null,
          fallback: event.text,
        })
        const distill = await runDiscordDistiller({
          reportText,
          fallbackText: event.text,
          ...(event.auditClaim ? { auditClaim: event.auditClaim as AuditClaim } : {}),
          dailyCap: args.distiller.dailyCap,
          usedToday,
          enabled: true,
          ...(args.distiller.runSession ? { runSession: args.distiller.runSession } : {}),
        })
        usedToday = distill.used
        if (!distill.usedFallback) {
          channels.discord = { text: distill.text }
          discordSource = "distilled"
          usedDistill += 1
        } else {
          channels.discord = { text: event.text }
          distillReason = distill.reason
        }
      } else {
        channels.discord = { text: event.text }
        distillReason = "disabled"
      }
    } else {
      channels.telegram = { text: event.text }
      channels.discord = { text: event.text }
    }

    const enriched: RouterEvent = { ...event, channels }
    await outbox.enrich(enriched)

    const receipt: ChannelRenderReceipt = {
      schema: 1,
      runId: args.runId,
      eventId: event.eventId as `sha256:${string}`,
      renderedAt: args.nowIso,
      telegram: telegramSource,
      discord: discordSource,
      ...(distillReason ? { distillReason } : {}),
      ...(inputHash ? { inputHash } : {}),
    }
    receipts.push(receipt)
    rendered += 1
  }

  if (receipts.length > 0) {
    await writeJsonRecordFsync(
      join(runArchiveDir(args.layout, args.runId), "channel-render-receipts.json"),
      {
        schema: 1,
        runId: args.runId,
        updatedAt: args.nowIso,
        receipts,
      } as never,
    )
  }

  return { rendered, skipped, usedDistill, distillUsedToday: usedToday, receipts }
}

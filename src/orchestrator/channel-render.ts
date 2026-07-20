import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ArchiveLayout } from "../lib/archive.js"
import { runArchiveDir, writeJsonRecordFsync } from "../lib/archive.js"
import { sha256Json } from "../lib/canonical-json.js"
import { Outbox } from "../lib/outbox.js"
import type {
  AuditClaim,
  BroadcastItem,
  ChatSummaryReceipt,
  DeliveryReceipt,
  RouterChannelPayloads,
  RouterEvent,
} from "../contracts/schemas.js"
import { dayKey } from "./broadcast.js"
import { reserveBroadcast } from "./broadcast-ledger.js"
import { chatReportPath } from "./chat-report.js"
import {
  runDiscordDistiller,
  runTelegramOverviewDistiller,
  type DistillSessionRunner,
} from "./distill-session.js"
import type { StageKnown } from "./narrative-stage-dedupe.js"
import {
  annotatePlatformCoverageText,
  claimRequiresPlatformCorroboration,
  platformCoverageLabel,
  resolveSocialPlatformsForClaim,
} from "./platform-coverage.js"

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
  telegram: "overview" | "broadcast-text"
  discord: "distilled" | "broadcast-text" | "budget-skipped" | "run-deduped"
  distillReason?: string
  telegramReason?: string
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
 * delivery. Telegram is always attached (uncapped). Discord is reserved against
 * the Discord-only daily/urgent budget and omitted when over budget so the router
 * skips that destination. At most one Discord payload per run (later claims omit
 * channels.discord as run-deduped, without burning budget). Idempotent on resume.
 */
export async function renderChannelPayloads(args: Readonly<{
  agentRoot: string
  layout: ArchiveLayout
  runId: string
  nowIso: string
  chatSummary?: ChatSummaryReceipt
  discordBudget: Readonly<{
    dailyBudget: number
    urgentCeiling: number
  }>
  distiller: Readonly<{
    enabled: boolean
    dailyCap: number
    usedToday: number
    runSession?: DistillSessionRunner
  }>
  telegramOverview: Readonly<{
    enabled: boolean
    dailyCap: number
    usedToday: number
    runSession?: DistillSessionRunner
  }>
  /** Narratives at unchanged heat — Discord must not restate; Telegram may */
  unchangedStages?: readonly StageKnown[]
}>): Promise<Readonly<{
  rendered: number
  skipped: number
  usedDistill: number
  usedTelegramOverview: number
  distillUsedToday: number
  discordBudgetSkipped: number
  receipts: readonly ChannelRenderReceipt[]
}>> {
  const outbox = new Outbox(join(args.layout.routerOutbox, args.runId))
  const events = outbox.list()
  const deliveries = loadDeliveryReceipts(args.layout, args.runId)
  const reportText = readPromotedReport(args)
  const receipts: ChannelRenderReceipt[] = []
  let rendered = 0
  let skipped = 0
  let usedToday = Math.max(args.distiller.usedToday, args.telegramOverview.usedToday)
  let usedDistill = 0
  let usedTelegramOverview = 0
  let discordBudgetSkipped = 0
  let discordAttachedThisRun = false
  const day = dayKey(new Date(args.nowIso))

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
    let telegramReason: string | undefined
    let inputHash: `sha256:${string}` | undefined

    const coverageLabel = (() => {
      const claim = event.auditClaim
      if (!claim || !claimRequiresPlatformCorroboration(claim.type)) return undefined
      const platforms = resolveSocialPlatformsForClaim(args.agentRoot, {
        auditClaim: claim,
        refs: event.refs,
      })
      return platformCoverageLabel(platforms)
    })()
    const broadcastText = annotatePlatformCoverageText(event.text, coverageLabel)

    if (reportText && args.telegramOverview.enabled) {
      inputHash = sha256Json({
        report: reportText,
        claim: event.auditClaim ?? null,
        fallback: broadcastText,
      })
      const overview = await runTelegramOverviewDistiller({
        reportText,
        fallbackText: broadcastText,
        ...(event.auditClaim ? { auditClaim: event.auditClaim as AuditClaim } : {}),
        ...(args.unchangedStages && args.unchangedStages.length > 0
          ? { knownStages: args.unchangedStages }
          : {}),
        dailyCap: args.telegramOverview.dailyCap,
        usedToday,
        enabled: true,
        ...(args.telegramOverview.runSession
          ? { runSession: args.telegramOverview.runSession }
          : {}),
      })
      usedToday = overview.used
      if (!overview.usedFallback) {
        channels.telegram = { text: overview.text.slice(0, 64_000) }
        telegramSource = "overview"
        usedTelegramOverview += 1
      } else {
        channels.telegram = { text: broadcastText }
        telegramReason = overview.reason
      }
    } else {
      channels.telegram = { text: broadcastText }
      if (reportText && !args.telegramOverview.enabled) telegramReason = "disabled"
    }

    if (discordAttachedThisRun) {
      discordSource = "run-deduped"
      distillReason = "run-deduped"
    } else {
      const severity = event.severity as BroadcastItem["severity"]
      const reservation = await reserveBroadcast({
        layout: args.layout,
        dayKey: day,
        reservationKey: event.eventId,
        severity,
        dailyBudget: args.discordBudget.dailyBudget,
        urgentCeiling: args.discordBudget.urgentCeiling,
        nowIso: args.nowIso,
      })

      if (!reservation.ok) {
        discordSource = "budget-skipped"
        distillReason = `budget:${reservation.reason ?? "rejected"}`
        discordBudgetSkipped += 1
      } else if (reportText && args.distiller.enabled) {
        inputHash ??= sha256Json({
          report: reportText,
          claim: event.auditClaim ?? null,
          fallback: broadcastText,
        })
        const distill = await runDiscordDistiller({
          reportText,
          fallbackText: broadcastText,
          ...(event.auditClaim ? { auditClaim: event.auditClaim as AuditClaim } : {}),
          ...(args.unchangedStages && args.unchangedStages.length > 0
            ? { unchangedStages: args.unchangedStages }
            : {}),
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
          channels.discord = { text: broadcastText }
          distillReason = distill.reason
        }
        discordAttachedThisRun = true
      } else {
        channels.discord = { text: broadcastText }
        if (reportText && !args.distiller.enabled) distillReason = "disabled"
        discordAttachedThisRun = true
      }
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
      ...(telegramReason ? { telegramReason } : {}),
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

  return {
    rendered,
    skipped,
    usedDistill,
    usedTelegramOverview,
    distillUsedToday: usedToday,
    discordBudgetSkipped,
    receipts,
  }
}

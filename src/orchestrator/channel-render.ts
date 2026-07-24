import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ArchiveLayout } from "../lib/archive.js"
import { runArchiveDir, writeJsonRecordFsync } from "../lib/archive.js"
import { sha256Json } from "../lib/canonical-json.js"
import { preferredNarrativeLabel } from "../lib/narrative-label.js"
import { effectiveFraming } from "../lib/narrative-framing.js"
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
  runTelegramTopicDistiller,
  renderTopicFallback,
  type DistillBudgetFraction,
  type DistillSessionRunner,
  type TopicNarrativeSnapshot,
  type TopicPacket,
  type TopicPacketMember,
} from "./distill-session.js"
import type { NarrativeLogEntry } from "./narrative-log.js"
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

const SEVERITY_RANK: Record<string, number> = {
  urgent: 0,
  notable: 1,
  watch: 2,
}

export type ChannelRenderReceipt = Readonly<{
  schema: 1
  runId: string
  eventId: `sha256:${string}`
  renderedAt: string
  telegram: "topic-deep-dive" | "topic-fallback" | "topic-merged" | "broadcast-text"
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

function normalizeSubject(event: RouterEvent): string {
  return (event.auditClaim?.subject ?? "").trim().toLowerCase()
}

function snapshotFromNarrative(entry: NarrativeLogEntry): TopicNarrativeSnapshot {
  const framing = effectiveFraming(entry)
  return {
    slug: entry.slug,
    stage: entry.stage,
    tickers: entry.tickers ?? [],
    lastSeen: entry.lastSeen,
    title: entry.title,
    framing,
  }
}

function chooseTelegramLeader(events: readonly RouterEvent[]): RouterEvent {
  return [...events].sort((a, b) => {
    const rankA = SEVERITY_RANK[a.severity] ?? 99
    const rankB = SEVERITY_RANK[b.severity] ?? 99
    if (rankA !== rankB) return rankA - rankB
    return a.eventId.localeCompare(b.eventId)
  })[0]!
}

export function buildTopicPacket(args: Readonly<{
  leader: RouterEvent
  members: readonly RouterEvent[]
  activeNarratives?: readonly NarrativeLogEntry[]
}>): TopicPacket {
  const subject = normalizeSubject(args.leader)
  const narratives = args.activeNarratives ?? []
  const matched = narratives.find((entry) => entry.slug === subject)
  const orderedMembers = [
    args.leader,
    ...args.members.filter((event) => event.eventId !== args.leader.eventId),
  ]
  const members: TopicPacketMember[] = orderedMembers.map((event) => ({
    eventId: event.eventId,
    severity: event.severity,
    text: event.text,
    ...(event.auditClaim ? { auditClaim: event.auditClaim as AuditClaim } : {}),
  }))
  const otherNarratives = narratives
    .filter((entry) => entry.slug !== subject)
    .map(snapshotFromNarrative)
  return {
    subject,
    subjectLabel: preferredNarrativeLabel({
      slug: subject.length > 0 ? subject : "unknown",
      ...(matched ? { title: matched.title, framing: effectiveFraming(matched) } : {}),
    }),
    ...(matched ? { narrative: snapshotFromNarrative(matched) } : {}),
    members,
    otherNarratives,
  }
}

/**
 * Enrich staged finding.broadcast events with per-channel payloads before HMAC
 * delivery. Telegram: one topic deep-dive per normalized subject per run (leaders
 * only). Discord: reserved against the Discord-only daily/urgent budget and at
 * most one payload per run. Idempotent on resume.
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
    llmBudgetFraction?: number
    hotDayLlmBudgetFraction?: number
  }>
  telegramOverview: Readonly<{
    enabled: boolean
    dailyCap: number
    usedToday: number
    runSession?: DistillSessionRunner
    llmBudgetFraction?: number
    hotDayLlmBudgetFraction?: number
  }>
  /** Staged finding.broadcast count this run — drives hot-day distill fraction */
  hotDayMinStagedEvents?: number
  /** Narratives at unchanged heat — Discord must not restate */
  unchangedStages?: readonly StageKnown[]
  /** Active narratives for topic packets (retention-pruned host log) */
  activeNarratives?: readonly NarrativeLogEntry[]
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

  const pending: RouterEvent[] = []
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
    pending.push(event)
  }

  const groups = new Map<string, RouterEvent[]>()
  for (const event of pending) {
    const subject = normalizeSubject(event)
    const key = subject.length > 0 ? subject : event.eventId
    const list = groups.get(key) ?? []
    list.push(event)
    groups.set(key, list)
  }

  const telegramLeaderIds = new Set<string>()
  const packetsByLeader = new Map<string, TopicPacket>()
  for (const group of groups.values()) {
    const leader = chooseTelegramLeader(group)
    telegramLeaderIds.add(leader.eventId)
    packetsByLeader.set(
      leader.eventId,
      buildTopicPacket({
        leader,
        members: group,
        ...(args.activeNarratives ? { activeNarratives: args.activeNarratives } : {}),
      }),
    )
  }

  const stagedEventsThisRun = pending.length
  const hotDayMin = args.hotDayMinStagedEvents ?? 20
  const discordBudgetFraction: DistillBudgetFraction | undefined =
    args.distiller.llmBudgetFraction !== undefined
      ? {
        llmBudgetFraction: args.distiller.llmBudgetFraction,
        hotDayLlmBudgetFraction:
          args.distiller.hotDayLlmBudgetFraction ?? args.distiller.llmBudgetFraction,
        hotDayMinStagedEvents: hotDayMin,
        stagedEventsThisRun,
      }
      : undefined
  const telegramBudgetFraction: DistillBudgetFraction | undefined =
    args.telegramOverview.llmBudgetFraction !== undefined
      ? {
        llmBudgetFraction: args.telegramOverview.llmBudgetFraction,
        hotDayLlmBudgetFraction:
          args.telegramOverview.hotDayLlmBudgetFraction
            ?? args.telegramOverview.llmBudgetFraction,
        hotDayMinStagedEvents: hotDayMin,
        stagedEventsThisRun,
      }
      : undefined

  for (const event of pending) {
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
    const isTelegramLeader = telegramLeaderIds.has(event.eventId)

    if (!isTelegramLeader) {
      telegramSource = "topic-merged"
      telegramReason = "topic-merged"
    } else if (args.telegramOverview.enabled) {
      const packet = packetsByLeader.get(event.eventId)!
      const fallbackText = renderTopicFallback(packet)
      inputHash = sha256Json({
        packet: {
          subject: packet.subject,
          subjectLabel: packet.subjectLabel,
          narrative: packet.narrative
            ? {
              slug: packet.narrative.slug,
              stage: packet.narrative.stage,
              tickers: [...packet.narrative.tickers],
              lastSeen: packet.narrative.lastSeen,
            }
            : null,
          members: packet.members.map((member) => ({
            eventId: member.eventId,
            severity: member.severity,
            text: member.text,
            auditClaim: member.auditClaim
              ? {
                type: member.auditClaim.type,
                subject: member.auditClaim.subject,
                direction: member.auditClaim.direction,
                horizonHours: member.auditClaim.horizonHours,
                verificationRule: member.auditClaim.verificationRule,
              }
              : null,
          })),
          otherNarratives: packet.otherNarratives.map((entry) => ({
            slug: entry.slug,
            stage: entry.stage,
            tickers: [...entry.tickers],
            lastSeen: entry.lastSeen,
          })),
        },
        fallback: fallbackText,
      })
      const topic = await runTelegramTopicDistiller({
        packet,
        fallbackText,
        dailyCap: args.telegramOverview.dailyCap,
        usedToday,
        enabled: true,
        ...(telegramBudgetFraction ? { budgetFraction: telegramBudgetFraction } : {}),
        ...(args.telegramOverview.runSession
          ? { runSession: args.telegramOverview.runSession }
          : {}),
      })
      usedToday = topic.used
      channels.telegram = { text: topic.text.slice(0, 64_000) }
      if (!topic.usedFallback) {
        telegramSource = "topic-deep-dive"
        usedTelegramOverview += 1
      } else {
        telegramSource = "topic-fallback"
        telegramReason = topic.reason
      }
    } else {
      channels.telegram = { text: broadcastText }
      telegramReason = "disabled"
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
          ...(discordBudgetFraction ? { budgetFraction: discordBudgetFraction } : {}),
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

    try {
      const {
        broadcastClaimId,
        loadMarketClaimIndex,
        saveMarketClaimIndex,
        upsertMarketClaim,
      } = await import("./market-claims.js")
      const claimId = broadcastClaimId(event.eventId)
      let index = loadMarketClaimIndex(args.agentRoot)
      const existing = index.claims.find((c) => c.claimId === claimId)
      if (existing) {
        const destinations: Array<"telegram" | "discord"> = []
        if (channels.telegram) destinations.push("telegram")
        if (channels.discord) destinations.push("discord")
        if (destinations.length > 0) {
          index = upsertMarketClaim(index, { ...existing, destinations })
          await saveMarketClaimIndex(args.agentRoot, index)
        }
      }
    } catch {
      // claim index is best-effort; delivery still proceeds
    }

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

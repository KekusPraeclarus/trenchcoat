import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { FetchLike } from "../collectors/market/geckoterminal.js"
import { Outbox } from "../lib/outbox.js"
import { runArchiveDir, writeJsonRecordFsync, type ArchiveLayout } from "../lib/archive.js"
import { sha256Json } from "../lib/canonical-json.js"
import { deliverRouterEvent, RouterDeliveryError } from "./router.js"
import type { DeliveryReceipt, RouterEvent } from "../contracts/schemas.js"

const TERMINAL: ReadonlySet<DeliveryReceipt["status"]> = new Set([
  "accepted",
  "duplicate",
  "conflict",
])

/** Minimum wait after a failed attempt before another ingress POST (backoff) */
export const DELIVERY_RETRY_BACKOFF_MS = 60_000
export const DEFAULT_DELIVERY_RETRY_BATCH = 25

function deliveryReceiptsPath(layout: ArchiveLayout, runId: string): string {
  return join(runArchiveDir(layout, runId), "delivery-receipts.json")
}

function loadExisting(layout: ArchiveLayout, runId: string): Map<string, DeliveryReceipt> {
  const path = deliveryReceiptsPath(layout, runId)
  const map = new Map<string, DeliveryReceipt>()
  if (!existsSync(path)) return map
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { receipts?: DeliveryReceipt[] }
    for (const receipt of parsed.receipts ?? []) map.set(receipt.eventId, receipt)
  } catch {
    // Corrupt journal is ignored; delivery re-derives from the staged outbox.
  }
  return map
}

function buildReceipt(args: Readonly<{
  runId: string
  eventId: `sha256:${string}`
  status: DeliveryReceipt["status"]
  deliveredAt: string
  deliveryId?: string
  error?: string
}>): DeliveryReceipt {
  return {
    schema: 1,
    receiptId: sha256Json({
      runId: args.runId,
      eventId: args.eventId,
      status: args.status,
      deliveredAt: args.deliveredAt,
    }),
    runId: args.runId,
    eventId: args.eventId,
    status: args.status,
    ...(args.deliveryId ? { deliveryId: args.deliveryId } : {}),
    ...(args.error ? { error: args.error.slice(0, 500) } : {}),
    deliveredAt: args.deliveredAt,
  }
}

async function attempt(
  fetcher: FetchLike,
  event: RouterEvent,
  args: Readonly<{ runId: string; routerUrl: string; hmacKey: string; nowIso: string; allowInsecureLoopback: boolean }>,
): Promise<DeliveryReceipt> {
  const eventId = event.eventId as `sha256:${string}`
  if (event.type === "finding.broadcast" && !event.channels?.telegram) {
    return buildReceipt({
      runId: args.runId,
      eventId,
      status: "failed",
      error: "finding.broadcast requires rendered Telegram channel payload before ingress",
      deliveredAt: args.nowIso,
    })
  }
  if (
    event.type === "finding.correction"
    && !event.channels?.telegram
    && !event.channels?.discord
  ) {
    return buildReceipt({
      runId: args.runId,
      eventId,
      status: "failed",
      error: "finding.correction requires at least one destination channel payload",
      deliveredAt: args.nowIso,
    })
  }
  try {
    const result = await deliverRouterEvent(
      fetcher,
      args.routerUrl,
      args.hmacKey,
      event,
      10_000,
      args.allowInsecureLoopback,
    )
    return buildReceipt({
      runId: args.runId,
      eventId,
      status: result.status,
      deliveryId: result.deliveryId,
      deliveredAt: args.nowIso,
    })
  } catch (error) {
    // 409 surfaces as a non-retryable conflict; everything else stays failed so it
    // remains queued for a later cycle. Either way we attempt each event once here,
    // so a persistent conflict can never spin into an infinite retry.
    const conflict = error instanceof RouterDeliveryError && /conflict/iu.test(error.message)
    return buildReceipt({
      runId: args.runId,
      eventId,
      status: conflict ? "conflict" : "failed",
      error: error instanceof Error ? error.message : "delivery error",
      deliveredAt: args.nowIso,
    })
  }
}

function eventNeedsIngress(
  event: RouterEvent,
  prior: DeliveryReceipt | undefined,
  nowMs: number,
  backoffMs: number,
): boolean {
  if (!prior) return true
  if (TERMINAL.has(prior.status)) return false
  if (prior.status === "failed") {
    const last = Date.parse(prior.deliveredAt)
    if (Number.isFinite(last) && nowMs - last < backoffMs) return false
    return true
  }
  // skipped / unknown → retry
  return true
}

/**
 * Deliver every staged RouterEvent for a run exactly once per invocation, appending
 * a receipt for each. Already-terminal events (accepted, duplicate, conflict) are
 * skipped so retries resume without re-POSTing settled deliveries.
 */
export async function deliverStagedOutbox(args: Readonly<{
  layout: ArchiveLayout
  runId: string
  routerUrl: string
  hmacKey: string
  nowIso: string
  fetcher: FetchLike
  allowInsecureLoopback?: boolean
  /** When set, skip failed receipts still inside the backoff window */
  backoffMs?: number
  /** Cap attempts this invocation (oldest staged events first) */
  maxAttempts?: number
}>): Promise<readonly DeliveryReceipt[]> {
  const outbox = new Outbox(join(args.layout.routerOutbox, args.runId))
  const events = outbox.list().sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
  const receipts = loadExisting(args.layout, args.runId)
  const allowInsecureLoopback = Boolean(args.allowInsecureLoopback)
  const backoffMs = args.backoffMs ?? 0
  const nowMs = Date.parse(args.nowIso)
  let attemptsLeft = args.maxAttempts ?? Number.POSITIVE_INFINITY

  const ordered: DeliveryReceipt[] = []
  for (const event of events) {
    const prior = receipts.get(event.eventId)
    if (prior && TERMINAL.has(prior.status)) {
      ordered.push(prior)
      continue
    }
    if (attemptsLeft <= 0 || !eventNeedsIngress(event, prior, nowMs, backoffMs)) {
      if (prior) ordered.push(prior)
      continue
    }
    attemptsLeft -= 1
    const receipt = await attempt(args.fetcher, event, {
      runId: args.runId,
      routerUrl: args.routerUrl,
      hmacKey: args.hmacKey,
      nowIso: args.nowIso,
      allowInsecureLoopback,
    })
    receipts.set(event.eventId, receipt)
    ordered.push(receipt)
    // Persist after every attempt so an interrupted run is resumable.
    await writeJsonRecordFsync(
      deliveryReceiptsPath(args.layout, args.runId),
      { schema: 1, runId: args.runId, updatedAt: args.nowIso, receipts: [...receipts.values()] } as never,
    )
  }

  return ordered
}

export type IngressPendingItem = Readonly<{
  runId: string
  eventId: string
  occurredAt: string
}>

/** Oldest-first staged events that still lack a terminal ingress receipt */
export function listIngressPending(
  layout: ArchiveLayout,
  nowIso?: string,
  backoffMs = DELIVERY_RETRY_BACKOFF_MS,
): readonly IngressPendingItem[] {
  if (!existsSync(layout.routerOutbox)) return []
  const nowMs = nowIso ? Date.parse(nowIso) : Date.now()
  const pending: IngressPendingItem[] = []
  const runIds = readdirSync(layout.routerOutbox)
    .filter((name) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(name))
    .sort()
  for (const runId of runIds) {
    const outbox = new Outbox(join(layout.routerOutbox, runId))
    const receipts = loadExisting(layout, runId)
    for (const event of outbox.list()) {
      const prior = receipts.get(event.eventId)
      if (!eventNeedsIngress(event, prior, nowMs, backoffMs)) continue
      pending.push({
        runId,
        eventId: event.eventId,
        occurredAt: event.occurredAt,
      })
    }
  }
  return pending.sort((a, b) => {
    const byTime = a.occurredAt.localeCompare(b.occurredAt)
    if (byTime !== 0) return byTime
    return a.runId.localeCompare(b.runId) || a.eventId.localeCompare(b.eventId)
  })
}

export type DeliveryRetryReport = Readonly<{
  scannedRuns: number
  pendingBefore: number
  attempted: number
  accepted: number
  duplicate: number
  conflict: number
  failed: number
  deferred: number
  receipts: readonly DeliveryReceipt[]
}>

/**
 * Bounded host-only ingress retry across all staged run outboxes. Relies on
 * router `(eventId, payloadHash)` dedupe; persists after every attempt.
 */
export async function retryPendingDeliveries(args: Readonly<{
  layout: ArchiveLayout
  routerUrl: string
  hmacKey: string
  nowIso: string
  fetcher: FetchLike
  prepareRun?: (runId: string) => Promise<void>
  allowInsecureLoopback?: boolean
  maxAttempts?: number
  backoffMs?: number
}>): Promise<DeliveryRetryReport> {
  const maxAttempts = args.maxAttempts ?? DEFAULT_DELIVERY_RETRY_BATCH
  const backoffMs = args.backoffMs ?? DELIVERY_RETRY_BACKOFF_MS
  const pending = listIngressPending(args.layout, args.nowIso, backoffMs)
  const batch = pending.slice(0, maxAttempts)
  const byRun = new Map<string, number>()
  for (const item of batch) {
    byRun.set(item.runId, (byRun.get(item.runId) ?? 0) + 1)
  }

  const allReceipts: DeliveryReceipt[] = []
  let accepted = 0
  let duplicate = 0
  let conflict = 0
  let failed = 0

  const runIds = [...byRun.keys()].sort()
  for (const runId of runIds) {
    const cap = byRun.get(runId) ?? 0
    if (args.prepareRun) await args.prepareRun(runId)
    const receipts = await deliverStagedOutbox({
      layout: args.layout,
      runId,
      routerUrl: args.routerUrl,
      hmacKey: args.hmacKey,
      nowIso: args.nowIso,
      fetcher: args.fetcher,
      ...(args.allowInsecureLoopback !== undefined
        ? { allowInsecureLoopback: args.allowInsecureLoopback }
        : {}),
      backoffMs,
      maxAttempts: cap,
    })
    for (const receipt of receipts) {
      if (receipt.deliveredAt !== args.nowIso) continue
      allReceipts.push(receipt)
      if (receipt.status === "accepted") accepted += 1
      else if (receipt.status === "duplicate") duplicate += 1
      else if (receipt.status === "conflict") conflict += 1
      else if (receipt.status === "failed") failed += 1
    }
  }

  const runDirs = existsSync(args.layout.routerOutbox)
    ? readdirSync(args.layout.routerOutbox).filter((n) => /^[A-Za-z0-9]/u.test(n)).length
    : 0

  return {
    scannedRuns: runDirs,
    pendingBefore: pending.length,
    attempted: allReceipts.length,
    accepted,
    duplicate,
    conflict,
    failed,
    deferred: Math.max(0, pending.length - batch.length),
    receipts: allReceipts,
  }
}

/** Counts for health / status snapshots (export for later wiring) */
export type BroadcastIngressCounts = Readonly<{
  staged: number
  ingressPending: number
  accepted: number
  duplicate: number
  conflict: number
  failed: number
  skipped: number
}>

export function summarizeIngressCounts(
  layout: ArchiveLayout,
  nowIso?: string,
): BroadcastIngressCounts {
  let staged = 0
  let ingressPending = 0
  let accepted = 0
  let duplicate = 0
  let conflict = 0
  let failed = 0
  let skipped = 0
  if (!existsSync(layout.routerOutbox)) {
    return { staged, ingressPending, accepted, duplicate, conflict, failed, skipped }
  }
  const nowMs = nowIso ? Date.parse(nowIso) : Date.now()
  for (const runId of readdirSync(layout.routerOutbox)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(runId)) continue
    const events = new Outbox(join(layout.routerOutbox, runId)).list()
    const receipts = loadExisting(layout, runId)
    staged += events.length
    for (const event of events) {
      const prior = receipts.get(event.eventId)
      if (!prior) {
        ingressPending += 1
        continue
      }
      if (prior.status === "accepted") accepted += 1
      else if (prior.status === "duplicate") duplicate += 1
      else if (prior.status === "conflict") conflict += 1
      else if (prior.status === "failed") {
        failed += 1
        if (eventNeedsIngress(event, prior, nowMs, DELIVERY_RETRY_BACKOFF_MS)) {
          ingressPending += 1
        }
      } else if (prior.status === "skipped") skipped += 1
      else ingressPending += 1
    }
  }
  return { staged, ingressPending, accepted, duplicate, conflict, failed, skipped }
}

/** Reject / stage helper shape for future health snapshot work */
export type BroadcastPipelineSnapshot = Readonly<{
  ingress: BroadcastIngressCounts
}>

export function snapshotBroadcastPipeline(layout: ArchiveLayout, nowIso?: string): BroadcastPipelineSnapshot {
  return { ingress: summarizeIngressCounts(layout, nowIso) }
}

import { existsSync, readFileSync } from "node:fs"
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
}>): Promise<readonly DeliveryReceipt[]> {
  const outbox = new Outbox(join(args.layout.routerOutbox, args.runId))
  const events = outbox.list()
  const receipts = loadExisting(args.layout, args.runId)
  const allowInsecureLoopback = Boolean(args.allowInsecureLoopback)

  const ordered: DeliveryReceipt[] = []
  for (const event of events) {
    const prior = receipts.get(event.eventId)
    if (prior && TERMINAL.has(prior.status)) {
      ordered.push(prior)
      continue
    }
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

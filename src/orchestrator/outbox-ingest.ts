import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Outbox } from "../lib/outbox.js"
import { runArchiveDir, writeJsonRecordFsync, type ArchiveLayout } from "../lib/archive.js"
import { sha256Json } from "../lib/canonical-json.js"
import { buildBroadcastRouterEvent, validateBroadcastItem } from "./router.js"
import { dayKey } from "./broadcast.js"
import { reserveBroadcast } from "./broadcast-ledger.js"
import type { BroadcastItem, BroadcastRejectReceipt } from "../contracts/schemas.js"

/** agent/outbox/<run-id>.json — zero or more untrusted broadcast proposals */
export function outboxProposalPath(agentRoot: string, runId: string): string {
  return join(agentRoot, "outbox", `${runId}.json`)
}

type ProposedRead =
  | Readonly<{ ok: true; items: unknown[] }>
  | Readonly<{ ok: false; reason: string }>

/**
 * Accept `{ schema, items: [...] }` or a bare array. Wrong envelopes (e.g. `broadcasts`
 * or a lone `text` field) fail closed with an auditable reason — never silent empty.
 */
export function readProposedItems(agentRoot: string, runId: string): ProposedRead {
  const path = outboxProposalPath(agentRoot, runId)
  if (!existsSync(path)) return { ok: true, items: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return { ok: false, reason: "invalid-envelope:json-parse" }
  }
  if (Array.isArray(parsed)) return { ok: true, items: parsed }
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, reason: "invalid-envelope:not-object-or-array" }
  }
  const record = parsed as Record<string, unknown>
  if (Array.isArray(record["items"])) {
    return { ok: true, items: record["items"] }
  }
  if ("broadcasts" in record) {
    return { ok: false, reason: "invalid-envelope:use-items-not-broadcasts" }
  }
  if ("text" in record && !("items" in record)) {
    return { ok: false, reason: "invalid-envelope:wrap-text-in-items-array" }
  }
  if ("items" in record) {
    return { ok: false, reason: "invalid-envelope:items-not-array" }
  }
  return { ok: false, reason: "invalid-envelope:missing-items" }
}

export type OutboxIngestReport = Readonly<{
  staged: number
  rejected: number
  rejects: readonly { reason: string; itemHash?: `sha256:${string}` }[]
  items: readonly BroadcastItem[]
}>

/**
 * Validate the agent's broadcast proposals, reserve daily/urgent budget for each,
 * and stage the survivors as durable RouterEvents. Rejections are archived with a
 * receipt so every dropped item is auditable.
 */
export async function ingestOutbox(args: Readonly<{
  agentRoot: string
  layout: ArchiveLayout
  runId: string
  dailyBudget: number
  urgentCeiling: number
  nowIso: string
  marketBlind?: boolean
}>): Promise<OutboxIngestReport> {
  const proposed = readProposedItems(args.agentRoot, args.runId)
  const day = dayKey(new Date(args.nowIso))
  const outbox = new Outbox(join(args.layout.routerOutbox, args.runId))

  const accepted: BroadcastItem[] = []
  const rejects: { reason: string; itemHash?: `sha256:${string}` }[] = []
  const receipts: BroadcastRejectReceipt[] = []

  const reject = (reason: string, itemHash?: `sha256:${string}`): void => {
    rejects.push(itemHash ? { reason, itemHash } : { reason })
    receipts.push({
      schema: 1,
      rejectId: sha256Json({ runId: args.runId, reason, itemHash: itemHash ?? null }),
      runId: args.runId,
      reason,
      ...(itemHash ? { itemHash } : {}),
      rejectedAt: args.nowIso,
    })
  }

  if (!proposed.ok) {
    reject(proposed.reason)
    await writeJsonRecordFsync(
      join(runArchiveDir(args.layout, args.runId), "broadcast-rejects.json"),
      { schema: 1, runId: args.runId, rejectedAt: args.nowIso, rejects: receipts } as never,
    )
    return { staged: 0, rejected: 1, rejects, items: [] }
  }

  let staged = 0
  for (const raw of proposed.items) {
    const rawHash = sha256Json(raw as never)
    let item: BroadcastItem
    try {
      item = validateBroadcastItem(raw)
    } catch (error) {
      reject(error instanceof Error ? error.message.slice(0, 280) : "invalid-item", rawHash)
      continue
    }

    // Host gate: category rotation confirmation is missing when market-blind
    if (args.marketBlind) {
      const claim = item.auditClaim
      const isRotation = claim?.type === "rotation"
        || claim?.verificationRule === "rotation"
      const isUrgentRotation = item.severity === "urgent" && isRotation
      if (isRotation || isUrgentRotation) {
        reject("market-blind:rotation-forbidden", rawHash)
        continue
      }
    }

    // eventId is derived from run id + content only, so it is a stable idempotency
    // key across retries even though occurredAt varies.
    const event = buildBroadcastRouterEvent(args.runId, args.nowIso, item)
    const reservation = await reserveBroadcast({
      layout: args.layout,
      dayKey: day,
      reservationKey: event.eventId,
      severity: item.severity,
      dailyBudget: args.dailyBudget,
      urgentCeiling: args.urgentCeiling,
      nowIso: args.nowIso,
    })
    if (!reservation.ok) {
      reject(`budget:${reservation.reason ?? "rejected"}`, event.eventId as `sha256:${string}`)
      continue
    }

    await outbox.stage(event)
    accepted.push(item)
    staged += 1
  }

  await writeJsonRecordFsync(
    join(runArchiveDir(args.layout, args.runId), "broadcast-rejects.json"),
    { schema: 1, runId: args.runId, rejectedAt: args.nowIso, rejects: receipts } as never,
  )

  return { staged, rejected: rejects.length, rejects, items: accepted }
}

import { existsSync, readFileSync } from "node:fs"
import { broadcastBudgetPath, writeJsonRecordFsync, type ArchiveLayout } from "../lib/archive.js"
import {
  BroadcastBudgetLedgerSchema,
  type BroadcastBudgetLedger,
  type BroadcastItem,
} from "../contracts/schemas.js"

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/u

function freshLedger(dayKey: string): BroadcastBudgetLedger {
  return {
    schema: 1,
    day: dayKey,
    used: 0,
    urgentUsed: 0,
    reservations: {},
    updatedAt: `${dayKey}T00:00:00.000Z`,
  }
}

/** Read the UTC-day ledger, returning a fresh zeroed one when none exists yet */
export function loadBroadcastLedger(layout: ArchiveLayout, dayKey: string): BroadcastBudgetLedger {
  if (!DAY_KEY.test(dayKey)) throw new TypeError("dayKey must be YYYY-MM-DD")
  const path = broadcastBudgetPath(layout, dayKey)
  if (!existsSync(path)) return freshLedger(dayKey)
  const ledger = BroadcastBudgetLedgerSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  if (ledger.day !== dayKey) throw new Error("Ledger day does not match its path")
  return ledger
}

export type ReserveResult = Readonly<{
  ok: boolean
  ledger: BroadcastBudgetLedger
  reason?: string
}>

/**
 * Reserve one Discord broadcast slot, idempotent by reservationKey. Urgent items
 * draw against the urgent ceiling; everything else against the daily Discord
 * budget. Telegram is not gated here. A repeated key returns the existing ledger
 * without double counting, so retries are safe.
 */
export async function reserveBroadcast(args: Readonly<{
  layout: ArchiveLayout
  dayKey: string
  reservationKey: string
  severity: BroadcastItem["severity"]
  dailyBudget: number
  urgentCeiling: number
  nowIso: string
}>): Promise<ReserveResult> {
  const ledger = loadBroadcastLedger(args.layout, args.dayKey)

  if (Object.prototype.hasOwnProperty.call(ledger.reservations, args.reservationKey)) {
    return { ok: true, ledger }
  }

  if (args.severity === "urgent") {
    if (ledger.urgentUsed >= args.urgentCeiling) {
      return { ok: false, ledger, reason: "urgent-ceiling" }
    }
  } else if (ledger.used >= args.dailyBudget) {
    return { ok: false, ledger, reason: "daily-budget" }
  }

  const next: BroadcastBudgetLedger = {
    ...ledger,
    used: args.severity === "urgent" ? ledger.used : ledger.used + 1,
    urgentUsed: args.severity === "urgent" ? ledger.urgentUsed + 1 : ledger.urgentUsed,
    reservations: {
      ...ledger.reservations,
      [args.reservationKey]: { severity: args.severity, reservedAt: args.nowIso },
    },
    updatedAt: args.nowIso,
  }
  await writeJsonRecordFsync(broadcastBudgetPath(args.layout, args.dayKey), next)
  return { ok: true, ledger: next }
}

import { join } from "node:path"
import { type ArchiveLayout } from "../lib/archive.js"
import { StateStore } from "../lib/state.js"
import {
  SETTLE_AGENT_LOCK_ATTEMPTS,
  SETTLE_AGENT_LOCK_DELAY_MS,
  withAgentWorkspaceLockOrDefer,
} from "../lib/lock.js"
import type { CanonicalIdentity, LedgerPosition } from "../contracts/schemas.js"
import { loadDecisionBundle } from "./decision-bundle.js"
import { finalizeEntry, firstEligibleObservation } from "./ledger.js"
import { observationsFromBars, type BarProvider, type PriceBar } from "./observations.js"

const ENTRY_HORIZON_HOURS = 48

export type LedgerSettleReport = Readonly<{
  scanned: number
  entriesFinalized: number
  pending: number
  skipped: number
  lockDeferred?: boolean
}>

function decisionTsFor(position: LedgerPosition, layout: ArchiveLayout): string | undefined {
  const bundle = loadDecisionBundle(layout, position.decisionId)
  return bundle?.decisionTs
}

/**
 * Host-only paper-ledger settlement: entry-pending → open at the first post-decision
 * bar. Bar fetches run unlocked; ledger RMW takes a brief agent lock (INV-S10 / ADR 027).
 * Exit-pending finalization needs a drop cutoff on the position (follow-up).
 */
export async function runLedgerSettle(args: Readonly<{
  agentRoot: string
  layout: ArchiveLayout
  nowIso: string
  loadBars?: BarProvider<CanonicalIdentity>
  /** When false, skip withAgentWorkspaceLock (caller already holds agent lock) */
  acquireLock?: boolean
  lockAttempts?: number
  lockDelayMs?: number
}>): Promise<LedgerSettleReport> {
  const store = new StateStore(join(args.agentRoot, "state"))
  const acquireLock = args.acquireLock !== false
  const loadBars = args.loadBars

  const report = {
    scanned: 0,
    entriesFinalized: 0,
    pending: 0,
    skipped: 0,
  }

  const ledger = store.loadLedger()
  const pendingEntries = ledger.positions.filter((p) => p.status === "entry-pending")
  report.scanned = pendingEntries.length
  if (pendingEntries.length === 0) return report

  type Planned = Readonly<{
    positionId: string
    next: LedgerPosition
  }>
  const planned: Planned[] = []

  for (const position of pendingEntries) {
    if (!loadBars) {
      report.pending += 1
      continue
    }
    const decisionTs = decisionTsFor(position, args.layout)
    if (!decisionTs) {
      report.skipped += 1
      continue
    }

    let bars: readonly PriceBar[] | undefined
    try {
      bars = await loadBars(position.identity, ENTRY_HORIZON_HOURS)
    } catch {
      report.pending += 1
      continue
    }
    if (!bars || bars.length === 0) {
      report.pending += 1
      continue
    }

    const obs = firstEligibleObservation(decisionTs, observationsFromBars(bars))
    if (!obs) {
      report.pending += 1
      continue
    }
    planned.push({ positionId: position.positionId, next: finalizeEntry(position, obs) })
    report.entriesFinalized += 1
  }

  if (planned.length === 0) return report

  const commit = async (): Promise<void> => {
    let file = store.loadLedger()
    for (const item of planned) {
      const current = file.positions.find((p) => p.positionId === item.positionId)
      if (!current || current.status !== "entry-pending") continue
      const others = file.positions.filter((p) => p.positionId !== item.positionId)
      file = { schema: 1, positions: [...others, item.next] }
    }
    await store.saveLedger(file)
  }

  if (acquireLock) {
    const locked = await withAgentWorkspaceLockOrDefer(args.agentRoot, commit, {
      attempts: args.lockAttempts ?? SETTLE_AGENT_LOCK_ATTEMPTS,
      delayMs: args.lockDelayMs ?? SETTLE_AGENT_LOCK_DELAY_MS,
    })
    if (!locked.ok) {
      return {
        ...report,
        pending: report.pending + planned.length,
        entriesFinalized: 0,
        lockDeferred: true,
      }
    }
  } else {
    await commit()
  }

  return report
}

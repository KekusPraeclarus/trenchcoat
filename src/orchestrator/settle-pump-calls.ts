import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { type ArchiveLayout } from "../lib/archive.js"
import { loadConfig } from "../lib/config.js"
import { StateStore } from "../lib/state.js"
import {
  PumpCallEventSchema,
  type PumpCallEvent,
  type PumpCallerScore,
  type PumpCallerScoresFile,
  type OutcomeObservation,
} from "../contracts/schemas.js"
import { writeOutcomeObservation, readOutcomeObservation } from "./scorecard.js"
import {
  materializePeakObservation,
  PEAK_HORIZON_HOURS,
  PEAK_MAX_WAIT_DAYS,
  PEAK_QUIET_HOURS,
  type BarProvider,
} from "./observations.js"
import { fetchSecurityGate } from "../collectors/market/security.js"

const HIT_RETURN = 0.20
const PEAK_BAR_HORIZON_HOURS = PEAK_MAX_WAIT_DAYS * 24

export type PumpCallSettleReport = Readonly<{
  scanned: number
  written: number
  complete: number
  pending: number
  terminalLoss: number
  skipped: number
}>

function subjectIdFor(event: PumpCallEvent): string {
  const digest = createHash("sha256")
    .update(`${event.callerId}|${event.chain}|${event.tokenAddress}|${event.calledAt}`)
    .digest("hex")
    .slice(0, 40)
  return `pc-${digest}`
}

function loadPumpCallEvents(layout: ArchiveLayout): PumpCallEvent[] {
  const dir = layout.outcomes
  if (!existsSync(dir)) return []
  const events: PumpCallEvent[] = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.startsWith("pump-call-") || !name.endsWith(".json")) continue
    const body = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>
    for (const entry of (body["events"] as unknown[]) ?? []) {
      const parsed = PumpCallEventSchema.safeParse(entry)
      if (parsed.success) events.push(parsed.data)
    }
  }
  return events
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]!
  return (sorted[mid - 1]! + sorted[mid]!) / 2
}

function scoresFromObservations(
  rows: readonly Readonly<{
    handle: string
    observation: OutcomeObservation
  }>[],
  scoreCutoff: string,
  nowIso: string,
): PumpCallerScore[] {
  const cutoffMs = Date.parse(scoreCutoff)
  const byHandle = new Map<string, { peaks: number[], rugs: number, settled: number }>()
  for (const row of rows) {
    const status = row.observation.status
    if (status !== "complete" && status !== "terminal-loss") continue
    if (Date.parse(row.observation.observedAt) > cutoffMs) continue
    const bucket = byHandle.get(row.handle) ?? { peaks: [], rugs: 0, settled: 0 }
    bucket.settled += 1
    if (status === "terminal-loss") bucket.rugs += 1
    if (status === "complete" && row.observation.rawReturn !== undefined) {
      bucket.peaks.push(row.observation.rawReturn)
    }
    byHandle.set(row.handle, bucket)
  }
  const out: PumpCallerScore[] = []
  for (const [handle, bucket] of byHandle) {
    const hits = bucket.peaks.filter((r) => r >= HIT_RETURN).length
    const settledForHit = bucket.peaks.length
    out.push({
      handle,
      settledCalls: bucket.settled,
      hits,
      hitMean: settledForHit === 0 ? 0 : hits / settledForHit,
      medianPeakPct: median(bucket.peaks),
      rugExposure: bucket.settled === 0 ? 0 : bucket.rugs / bucket.settled,
      scoreCutoff,
      updatedAt: nowIso,
    })
  }
  return out.sort((a, b) => a.handle.localeCompare(b.handle))
}

export async function runSettlePumpCalls(args: Readonly<{
  layout: ArchiveLayout
  nowIso: string
  agentRoot?: string
  minAgeHours?: number
  loadBars?: BarProvider<PumpCallEvent>
  fetchSecurity?: typeof fetchSecurityGate
}>): Promise<PumpCallSettleReport> {
  let minAgeHours = args.minAgeHours
  if (minAgeHours === undefined) {
    try {
      minAgeHours = loadConfig().pump.calls.min_age_hours
    } catch {
      minAgeHours = 24
    }
  }
  const nowMs = Date.parse(args.nowIso)
  const events = loadPumpCallEvents(args.layout)
  const report = {
    scanned: 0,
    written: 0,
    complete: 0,
    pending: 0,
    terminalLoss: 0,
    skipped: 0,
  }
  const settledRows: Array<{ handle: string, observation: OutcomeObservation }> = []
  const security = args.fetchSecurity ?? fetchSecurityGate

  for (const event of events) {
    const subjectId = subjectIdFor(event)
    report.scanned += 1
    const existing = readOutcomeObservation(
      args.layout,
      "pump-call",
      subjectId,
      PEAK_HORIZON_HOURS,
    )
    if (existing && (existing.status === "complete" || existing.status === "terminal-loss")) {
      report.skipped += 1
      settledRows.push({ handle: event.callerId, observation: existing })
      continue
    }

    const ageHours = (nowMs - Date.parse(event.calledAt)) / 3_600_000
    if (!Number.isFinite(ageHours) || ageHours < minAgeHours) {
      const pending: OutcomeObservation = {
        schema: 1,
        subjectType: "pump-call",
        subjectId,
        horizonHours: PEAK_HORIZON_HOURS,
        observationSpecVersion: 2,
        status: "provider-pending",
        eventTs: event.calledAt,
        exclusionReason: "min-age",
        observedAt: args.nowIso,
      }
      await writeOutcomeObservation(args.layout, pending)
      report.written += 1
      report.pending += 1
      continue
    }

    const gate = await security(globalThis.fetch, event.chain, event.tokenAddress)
    if (gate.hardFail) {
      const loss: OutcomeObservation = {
        schema: 1,
        subjectType: "pump-call",
        subjectId,
        horizonHours: PEAK_HORIZON_HOURS,
        observationSpecVersion: 2,
        status: "terminal-loss",
        eventTs: event.calledAt,
        exclusionReason: "rugged-after-call",
        observedAt: args.nowIso,
      }
      await writeOutcomeObservation(args.layout, loss)
      report.written += 1
      report.terminalLoss += 1
      settledRows.push({ handle: event.callerId, observation: loss })
      continue
    }

    const bars = (await Promise.resolve(args.loadBars?.(event, PEAK_BAR_HORIZON_HOURS))) ?? []
    if (bars.length === 0) {
      const pending: OutcomeObservation = {
        schema: 1,
        subjectType: "pump-call",
        subjectId,
        horizonHours: PEAK_HORIZON_HOURS,
        observationSpecVersion: 2,
        status: "provider-pending",
        eventTs: event.calledAt,
        exclusionReason: "missing-bars",
        observedAt: args.nowIso,
      }
      await writeOutcomeObservation(args.layout, pending)
      report.written += 1
      report.pending += 1
      continue
    }
    const observation = materializePeakObservation({
      subjectType: "pump-call",
      subjectId,
      eventTs: event.calledAt,
      bars,
      observedAt: args.nowIso,
      quietHours: PEAK_QUIET_HOURS,
      maxWaitDays: PEAK_MAX_WAIT_DAYS,
    })
    await writeOutcomeObservation(args.layout, observation)
    report.written += 1
    if (observation.status === "complete") report.complete += 1
    else if (observation.status === "terminal-loss") {
      report.terminalLoss += 1
      settledRows.push({ handle: event.callerId, observation })
    } else report.pending += 1
    if (observation.status === "complete") {
      settledRows.push({ handle: event.callerId, observation })
    }
  }

  if (args.agentRoot) {
    const state = new StateStore(join(args.agentRoot, "state"))
    const next: PumpCallerScoresFile = {
      schema: 1,
      callers: scoresFromObservations(settledRows, args.nowIso, args.nowIso),
    }
    await state.savePumpCallerScores(next)
  }

  return report
}

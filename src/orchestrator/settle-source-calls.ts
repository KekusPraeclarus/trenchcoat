import { type ArchiveLayout } from "../lib/archive.js"
import { type SourceCallEvent } from "../contracts/schemas.js"
import { isFomoProfileProvenance, readSourceCallLog } from "./call-log.js"
import { writeOutcomeObservation, readOutcomeObservation } from "./scorecard.js"
import {
  materializeObservation,
  type BarProvider,
  type BenchmarkProvider,
} from "./observations.js"

export const DEFAULT_HORIZONS = [24, 72, 168] as const
export const DEFAULT_SETTLEMENT_HOURS = 6

const HOUR_MS = 3_600_000
const SUBJECT_ID_MAX = 128

/** sourceId is colon-free (call-log), so slicing subjectId at the first ':' round-trips */
function subjectIdFor(event: SourceCallEvent): string {
  const token = event.tokenId ?? event.rawAddress
  const suffix = `:${token}`
  const room = Math.max(1, SUBJECT_ID_MAX - suffix.length)
  return `${event.sourceId.slice(0, room)}${suffix}`
}

function isMature(event: SourceCallEvent, horizonHours: number, settlementHours: number, nowMs: number): boolean {
  const maturityMs = Date.parse(event.mentionedAt) + (horizonHours + settlementHours) * HOUR_MS
  return maturityMs <= nowMs
}

export type SourceSettleReport = Readonly<{
  scanned: number
  written: number
  complete: number
  pending: number
  censored: number
  skipped: number
}>

/**
 * Price mature source-call events at each horizon into immutable outcome observations
 * under the path scorecard/sources helpers read. Resumable: an already-complete
 * observation is never re-priced, and missing data stays pending/censored, never a loss.
 */
export async function runSettleSourceCalls(args: Readonly<{
  layout: ArchiveLayout
  nowIso: string
  horizons?: readonly number[]
  settlementHours?: number
  loadBars?: BarProvider<SourceCallEvent>
  benchmark?: BenchmarkProvider<SourceCallEvent>
  feeBpsPerSide?: number
}>): Promise<SourceSettleReport> {
  const horizons = args.horizons ?? DEFAULT_HORIZONS
  const settlementHours = args.settlementHours ?? DEFAULT_SETTLEMENT_HOURS
  const nowMs = Date.parse(args.nowIso)
  if (!Number.isFinite(nowMs)) throw new TypeError("Invalid nowIso")

  const events = readSourceCallLog(args.layout)
  const report = { scanned: 0, written: 0, complete: 0, pending: 0, censored: 0, skipped: 0 }

  for (const event of events) {
    if (isFomoProfileProvenance(event.provenance)) continue
    const subjectId = subjectIdFor(event)
    for (const horizonHours of horizons) {
      if (!isMature(event, horizonHours, settlementHours, nowMs)) continue
      report.scanned += 1

      const existing = readOutcomeObservation(args.layout, "source-call", subjectId, horizonHours)
      if (existing && (existing.status === "complete" || existing.status === "terminal-loss")) {
        report.skipped += 1
        continue
      }

      const bars = (await Promise.resolve(args.loadBars?.(event, horizonHours))) ?? []
      const benchmark = await Promise.resolve(args.benchmark?.(event, horizonHours))
      const observation = materializeObservation({
        subjectType: "source-call",
        subjectId,
        eventTs: event.mentionedAt,
        horizonHours,
        bars,
        observedAt: args.nowIso,
        ...(benchmark !== undefined ? { benchmarkReturn: benchmark } : {}),
        ...(args.feeBpsPerSide !== undefined ? { feeBpsPerSide: args.feeBpsPerSide } : {}),
      })

      await writeOutcomeObservation(args.layout, observation)
      report.written += 1
      if (observation.status === "complete") report.complete += 1
      else if (observation.status === "provider-pending") report.pending += 1
      else report.censored += 1
    }
  }

  return report
}

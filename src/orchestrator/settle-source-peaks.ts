import { type ArchiveLayout } from "../lib/archive.js"
import { type SourceCallEvent } from "../contracts/schemas.js"
import { readSourceCallLog } from "./call-log.js"
import { writeOutcomeObservation, readOutcomeObservation } from "./scorecard.js"
import {
  materializePeakObservation,
  PEAK_HORIZON_HOURS,
  PEAK_MAX_WAIT_DAYS,
  PEAK_QUIET_HOURS,
  type BarProvider,
} from "./observations.js"

const SUBJECT_ID_MAX = 128
/** Hours of bars to request for peak lookback (14d + buffer) */
const PEAK_BAR_HORIZON_HOURS = PEAK_MAX_WAIT_DAYS * 24

function subjectIdFor(event: SourceCallEvent): string {
  const token = event.tokenId ?? event.rawAddress
  const suffix = `:${token}`
  const room = Math.max(1, SUBJECT_ID_MAX - suffix.length)
  return `${event.sourceId.slice(0, room)}${suffix}`
}

export type SourcePeakSettleReport = Readonly<{
  scanned: number
  written: number
  complete: number
  pending: number
  censored: number
  skipped: number
}>

/**
 * Settle source-call quality as peak% from entry. Defers while still sending
 * (new high within 6h); force-completes after 14d.
 */
export async function runSettleSourcePeaks(args: Readonly<{
  layout: ArchiveLayout
  nowIso: string
  loadBars?: BarProvider<SourceCallEvent>
  feeBpsPerSide?: number
  quietHours?: number
  maxWaitDays?: number
}>): Promise<SourcePeakSettleReport> {
  const nowMs = Date.parse(args.nowIso)
  if (!Number.isFinite(nowMs)) throw new TypeError("Invalid nowIso")
  const quietHours = args.quietHours ?? PEAK_QUIET_HOURS
  const maxWaitDays = args.maxWaitDays ?? PEAK_MAX_WAIT_DAYS

  const events = readSourceCallLog(args.layout)
  const report = { scanned: 0, written: 0, complete: 0, pending: 0, censored: 0, skipped: 0 }

  for (const event of events) {
    const subjectId = subjectIdFor(event)
    report.scanned += 1

    const existing = readOutcomeObservation(
      args.layout,
      "source-call",
      subjectId,
      PEAK_HORIZON_HOURS,
    )
    if (
      existing
      && existing.observationSpecVersion >= 2
      && (existing.status === "complete" || existing.status === "terminal-loss")
    ) {
      report.skipped += 1
      continue
    }

    const bars = (await Promise.resolve(args.loadBars?.(event, PEAK_BAR_HORIZON_HOURS))) ?? []
    const observation = materializePeakObservation({
      subjectType: "source-call",
      subjectId,
      eventTs: event.mentionedAt,
      bars,
      observedAt: args.nowIso,
      quietHours,
      maxWaitDays,
      ...(args.feeBpsPerSide !== undefined ? { feeBpsPerSide: args.feeBpsPerSide } : {}),
    })

    await writeOutcomeObservation(args.layout, observation)
    report.written += 1
    if (observation.status === "complete") report.complete += 1
    else if (observation.status === "provider-pending") report.pending += 1
    else report.censored += 1
  }

  return report
}

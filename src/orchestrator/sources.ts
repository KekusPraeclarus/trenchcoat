import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { ArchiveLayout } from "../lib/archive.js"
import type { SourceCallOutcome } from "../sources/outcomes.js"
import { OutcomeObservationSchema } from "../contracts/schemas.js"
import { PEAK_HORIZON_HOURS } from "./observations.js"
import { isFomoProfileProvenance, readSourceCallLog, xPostCallKey } from "./call-log.js"

/** Load sealed source-call outcomes from archive for lifecycle review (peak headline) */
export function loadSourceCallOutcomes(
  layout: ArchiveLayout,
): SourceCallOutcome[] {
  const root = join(layout.outcomes, "source-call")
  if (!existsSync(root)) return []
  const fomoKeys = new Set(
    readSourceCallLog(layout)
      .filter((event) => isFomoProfileProvenance(event.provenance))
      .map((event) => xPostCallKey({
        sourceId: event.sourceId,
        rawAddress: event.rawAddress,
        mentionedAt: event.mentionedAt,
      })),
  )
  const out: SourceCallOutcome[] = []
  for (const subjectId of readdirSync(root)) {
    const dir = join(root, subjectId)
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue
      const obs = OutcomeObservationSchema.parse(
        JSON.parse(readFileSync(join(dir, file), "utf8")),
      )
      if (obs.status !== "complete" && obs.status !== "terminal-loss") continue
      const isPeak = obs.observationSpecVersion >= 2
        || obs.horizonHours === PEAK_HORIZON_HOURS
      const isLegacy72 = obs.horizonHours === 72
      if (!isPeak && !isLegacy72) continue
      const colon = obs.subjectId.indexOf(":")
      const sourceId = colon >= 0 ? obs.subjectId.slice(0, colon) : obs.subjectId
      const token = colon >= 0 ? obs.subjectId.slice(colon + 1) : obs.subjectId
      if (fomoKeys.size > 0) {
        const key = xPostCallKey({
          sourceId,
          rawAddress: token,
          mentionedAt: obs.eventTs,
        })
        if (fomoKeys.has(key)) continue
      }
      const returnValue = obs.excessReturn
      out.push({
        eventId: `${obs.subjectId}:${obs.horizonHours}`,
        sourceId,
        tokenId: obs.subjectId,
        mentionedAt: obs.eventTs,
        settledAt: obs.observedAt,
        ...(returnValue !== undefined
          ? isPeak
            ? { peakReturn: returnValue }
            : { excessReturn72h: returnValue }
          : {}),
        rug: obs.status === "terminal-loss",
      })
    }
  }
  return out
}

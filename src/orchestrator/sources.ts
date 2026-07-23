import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { ArchiveLayout } from "../lib/archive.js"
import type { SourceCallOutcome } from "../sources/outcomes.js"
import { OutcomeObservationSchema } from "../contracts/schemas.js"
import { PEAK_HORIZON_HOURS } from "./observations.js"

/** Load sealed source-call outcomes from archive for lifecycle review (peak headline) */
export function loadSourceCallOutcomes(
  layout: ArchiveLayout,
): SourceCallOutcome[] {
  const root = join(layout.outcomes, "source-call")
  if (!existsSync(root)) return []
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
      const returnValue = obs.excessReturn
      out.push({
        eventId: `${obs.subjectId}:${obs.horizonHours}`,
        sourceId: obs.subjectId.includes(":")
          ? obs.subjectId.slice(0, obs.subjectId.indexOf(":"))
          : obs.subjectId,
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

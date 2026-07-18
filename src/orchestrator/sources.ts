import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { ArchiveLayout } from "../lib/archive.js"
import type { SourceCallOutcome } from "../sources/outcomes.js"
import { OutcomeObservationSchema } from "../contracts/schemas.js"

/** Load sealed source-call outcomes from archive for lifecycle review */
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
      out.push({
        eventId: `${obs.subjectId}:${obs.horizonHours}`,
        sourceId: obs.subjectId.includes(":")
          ? obs.subjectId.slice(0, obs.subjectId.indexOf(":"))
          : obs.subjectId,
        tokenId: obs.subjectId,
        mentionedAt: obs.eventTs,
        settledAt: obs.observedAt,
        ...(obs.horizonHours === 72 && obs.excessReturn !== undefined
          ? { excessReturn72h: obs.excessReturn }
          : {}),
        rug: obs.status === "terminal-loss",
      })
    }
  }
  return out
}

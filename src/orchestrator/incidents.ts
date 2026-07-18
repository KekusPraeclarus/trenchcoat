import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { runArchiveDir, writeJsonRecordFsync, type ArchiveLayout } from "../lib/archive.js"
import { assertRunId } from "../lib/run-id.js"
import { RunIncidentSchema, type RunIncident } from "../contracts/schemas.js"
import type { IncidentWriter } from "../contracts/interfaces.js"

function incidentsPath(layout: ArchiveLayout, runId: string): string {
  return join(runArchiveDir(layout, runId), "incidents.json")
}

export function readIncidents(layout: ArchiveLayout, runId: string): RunIncident[] {
  const path = incidentsPath(layout, runId)
  if (!existsSync(path)) return []
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown
  if (!Array.isArray(raw)) throw new TypeError("Incidents file is not an array")
  return raw.map((entry) => RunIncidentSchema.parse(entry))
}

export const appendRunIncident: IncidentWriter = async (layout, runId, incident) => {
  assertRunId(runId)
  const validated = RunIncidentSchema.parse(incident)
  if (validated.runId !== runId) {
    throw new Error("Incident runId does not match target run")
  }
  const next = [...readIncidents(layout, runId), validated]
  await writeJsonRecordFsync(incidentsPath(layout, runId), next as never)
}

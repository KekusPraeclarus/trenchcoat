import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  copyDirectoryManifest,
  runArchiveDir,
  writeJsonRecordFsync,
  type ArchiveLayout,
} from "../lib/archive.js"
import { assertRunId } from "../lib/run-id.js"
import { RunManifestSchema, type RunManifest } from "../contracts/schemas.js"
import type { PreSessionArchiveResult } from "../contracts/interfaces.js"

export type PreArchiveInput = Readonly<{
  layout: ArchiveLayout
  agentRoot: string
  runId: string
  job: string
  nowIso: string
}>

// Freeze the run's inputs into the archive before the agent session mutates state
export async function preArchiveRun(input: PreArchiveInput): Promise<PreSessionArchiveResult> {
  assertRunId(input.runId)
  const runDir = runArchiveDir(input.layout, input.runId)
  const destInbox = join(runDir, "inbox")
  mkdirSync(destInbox, { recursive: true, mode: 0o700 })

  const inboxSource = join(input.agentRoot, "inbox", input.runId)
  const inboxManifest = existsSync(inboxSource)
    ? await copyDirectoryManifest(inboxSource, destInbox)
    : {}

  const sourcesSource = join(input.agentRoot, "state", "sources.json")
  let sourcesStartHash: `sha256:${string}` | undefined
  if (existsSync(sourcesSource)) {
    const sources = JSON.parse(readFileSync(sourcesSource, "utf8")) as unknown
    sourcesStartHash = await writeJsonRecordFsync(
      join(runDir, "sources-start.json"),
      sources as never,
    )
  }

  const manifest: RunManifest = RunManifestSchema.parse({
    schema: 1,
    runId: input.runId,
    job: input.job,
    createdAt: input.nowIso,
    inboxManifest,
    ...(sourcesStartHash ? { sourcesStartHash } : {}),
    fileHashes: {},
  })
  await writeJsonRecordFsync(join(runDir, "manifest.json"), manifest as never)

  return { manifest, inboxDir: destInbox }
}

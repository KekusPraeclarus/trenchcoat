import { readFileSync } from "node:fs"
import { join } from "node:path"
import { StateStore } from "../lib/state.js"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { WorkspaceLock, agentLockPath } from "../lib/lock.js"
import { SourceWriter } from "./sources-write.js"
import {
  parseFcSourceSeedFile,
  seedFcSourceLifecycle,
  type FcSourceSeedFile,
} from "../sources/fc-seed.js"
import { normalizeFcHandle, sourceIdForFcHandle } from "../sources/fc-lifecycle.js"

export function loadFcSourceSeedFile(path: string): FcSourceSeedFile {
  return parseFcSourceSeedFile(JSON.parse(readFileSync(path, "utf8")))
}

export async function applyFcSourceSeed(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  seedPath: string
  runId?: string
  nowIso?: string
  dryRun?: boolean
  skipLock?: boolean
}>): Promise<Readonly<{
  added: number
  updated: number
  skipped: number
  transitionIds: string[]
  receiptPath: string
  dryRun: boolean
}>> {
  const lock = args.skipLock
    ? undefined
    : new WorkspaceLock(agentLockPath(args.agentRoot))
  if (lock && !lock.tryAcquire()) {
    throw new Error("workspace lock held — another writer owns agent state")
  }

  try {
    const seed = loadFcSourceSeedFile(args.seedPath)
    const store = new StateStore(join(args.agentRoot, "state"))
    const nowIso = args.nowIso ?? new Date().toISOString()
    const runId = args.runId ?? `fc-source-seed-${nowIso.replace(/[:.]/gu, "-")}`
    const result = seedFcSourceLifecycle({
      entries: seed.sources,
      existing: store.loadFcSourceLifecycle(),
      nowIso,
      runId,
    })

    if (!args.dryRun) {
      await store.saveFcSourceLifecycle(result.file)
      const writer = new SourceWriter(store)
      const seededIds = new Set(
        seed.sources.map((entry) => {
          const handle = normalizeFcHandle(entry.handle)
          if (!handle) throw new TypeError(`Invalid handle ${entry.handle}`)
          return sourceIdForFcHandle(handle)
        }),
      )
      for (const candidate of result.file.candidates) {
        if (!seededIds.has(candidate.sourceId)) continue
        await writer.upsertNeutralSource({
          sourceId: candidate.sourceId,
          handle: candidate.handle,
          platform: "farcaster",
        })
      }
    }

    const receiptPath = join(args.archiveRoot, "fc-source-seeds", `${runId}.json`)
    await writeAtomicFile(receiptPath, `${JSON.stringify({
      schema: 1,
      runId,
      seededAt: nowIso,
      seedPath: args.seedPath,
      dryRun: Boolean(args.dryRun),
      added: result.added,
      updated: result.updated,
      skipped: result.skipped,
      transitionIds: result.transitions.map((t) => t.transitionId),
      transitions: result.transitions,
    }, null, 2)}\n`)

    return {
      added: result.added,
      updated: result.updated,
      skipped: result.skipped,
      transitionIds: result.transitions.map((t) => t.transitionId),
      receiptPath,
      dryRun: Boolean(args.dryRun),
    }
  } finally {
    lock?.release()
  }
}

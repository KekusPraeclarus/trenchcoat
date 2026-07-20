import { existsSync, readFileSync } from "node:fs"
import { archiveLayout } from "../lib/archive.js"
import { systemClock } from "../lib/clock.js"
import { agentLockPath } from "../lib/lock.js"
import { log } from "../lib/log.js"
import { RUN_PHASES, markRunFailed, type RunJournal } from "./journal.js"
import { createJournalStore } from "./journal-store.js"
import {
  ABANDONED_CREATED_MS,
  findIncompleteRunRefs,
  type IncompleteRunRef,
} from "./resume.js"

/** Any still-running journal older than this is treated as an orphan */
export const ABANDONED_RUNNING_MS = ABANDONED_CREATED_MS

/**
 * Pre-seal journals with no live writer lock after this age are SIGTERM orphans
 * (resume of pre-seal is unsupported — mark failed and re-run).
 */
export const ORPHAN_PRESEAL_NO_LOCK_MS = 30 * 60_000

const COMMITTED_IDX = RUN_PHASES.indexOf("committed")

export function isPreSealPhase(phase: IncompleteRunRef["phase"]): boolean {
  const idx = RUN_PHASES.indexOf(phase)
  return idx >= 0 && idx < COMMITTED_IDX
}

export function workspaceLockHeldAlive(agentRoot: string): boolean {
  const ownerPath = `${agentLockPath(agentRoot)}.owner`
  if (!existsSync(ownerPath)) return false
  const pid = Number(readFileSync(ownerPath, "utf8").trim())
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function shouldAbandonIncomplete(args: Readonly<{
  ref: IncompleteRunRef
  lockHeld: boolean
  /** When true, also fail phase=created journals past ABANDONED_CREATED_MS */
  includeCreatedAbandoned?: boolean
}>): boolean {
  const { ref, lockHeld } = args
  if (ref.status === "abandoned") return args.includeCreatedAbandoned === true
  if (ref.status !== "running") return false
  const ageMs = ref.ageMs
  if (ageMs === undefined) return false
  if (ageMs >= ABANDONED_RUNNING_MS) return true
  if (isPreSealPhase(ref.phase) && !lockHeld && ageMs >= ORPHAN_PRESEAL_NO_LOCK_MS) {
    return true
  }
  return false
}

export async function failRunJournal(args: Readonly<{
  archiveRoot: string
  agentRoot?: string
  runId: string
  code: string
  message: string
  nowIso?: string
}>): Promise<RunJournal> {
  const store = createJournalStore(archiveLayout(args.archiveRoot))
  const existing = await store.load(args.runId)
  if (!existing) throw new Error(`journal missing: ${args.runId}`)
  if (existing.status === "complete") {
    throw new Error(`cannot fail completed run ${args.runId}`)
  }
  if (existing.status === "failed" && existing.failure) return existing
  const next = markRunFailed(existing, {
    code: args.code,
    message: args.message,
    failedAt: args.nowIso ?? systemClock.nowIso(),
  })
  await store.save(next)
  if (args.agentRoot) {
    await store.mirrorToAgent?.(args.agentRoot, next)
  }
  return next
}

export type AbandonResult = Readonly<{
  examined: number
  failed: readonly string[]
  skipped: readonly string[]
}>

/** Persist-fail orphaned incomplete journals so wait-idle / deploy can proceed */
export async function abandonOrphanedRuns(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  nowIso?: string
  /** When set, only fail these run ids (operator select) */
  onlyRunIds?: readonly string[]
  includeCreatedAbandoned?: boolean
  dryRun?: boolean
}>): Promise<AbandonResult> {
  const nowIso = args.nowIso ?? systemClock.nowIso()
  const lockHeld = workspaceLockHeldAlive(args.agentRoot)
  const refs = await findIncompleteRunRefs(archiveLayout(args.archiveRoot), nowIso)
  const failed: string[] = []
  const skipped: string[] = []

  for (const ref of refs) {
    if (args.onlyRunIds && !args.onlyRunIds.includes(ref.runId)) continue
    if (!shouldAbandonIncomplete({
      ref,
      lockHeld,
      ...(args.includeCreatedAbandoned ? { includeCreatedAbandoned: true } : {}),
    })) {
      skipped.push(ref.runId)
      continue
    }
    if (args.dryRun) {
      failed.push(ref.runId)
      continue
    }
    try {
      await failRunJournal({
        archiveRoot: args.archiveRoot,
        agentRoot: args.agentRoot,
        runId: ref.runId,
        code: ref.status === "abandoned" ? "orphan-created" : "orphan-stale",
        message: ref.status === "abandoned"
          ? `abandoned phase=created ageMs=${ref.ageMs ?? "unknown"}`
          : `orphaned incomplete phase=${ref.phase} ageMs=${ref.ageMs ?? "unknown"} lockHeld=${lockHeld}`,
        nowIso,
      })
      failed.push(ref.runId)
      log.warn("abandoned orphaned run", {
        runId: ref.runId,
        phase: ref.phase,
        ageMs: ref.ageMs ?? null,
      })
    } catch (error) {
      log.error("failed to abandon run", {
        runId: ref.runId,
        detail: error instanceof Error ? error.message : "unknown",
      })
      skipped.push(ref.runId)
    }
  }

  return {
    examined: refs.length,
    failed,
    skipped,
  }
}

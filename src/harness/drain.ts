import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { writeAtomicFile, sha256Bytes } from "../lib/fs-atomic.js"
import { WorkspaceLock, agentLockPath } from "../lib/lock.js"
import { archiveLayout } from "../lib/archive.js"
import { buildHealthSnapshot, type HealthSnapshot } from "../orchestrator/health.js"
import { findIncompleteRunRefs } from "../orchestrator/resume.js"
import { snapshotBroadcastPipeline } from "../orchestrator/delivery.js"
import { filePendingResearchStore } from "../chat/pending-research.js"
import { discordLayout } from "../discord/paths.js"
import { createDiscordStore } from "../discord/store.js"
import {
  AgentDeploymentManifestSchema,
  type AgentDeploymentManifest,
} from "../contracts/schemas.js"
import { systemClock } from "../lib/clock.js"
import { DECISION_POLICY_REL_PATH } from "./paths.js"
import { hypothesisDir } from "./propose.js"

export type DrainSnapshot = Readonly<{
  capturedAt: string
  lockHeld: boolean
  lockStale: boolean
  /** @deprecated Prefer runningIncompleteRuns — kept for older receipts */
  incompleteRuns: number
  runningIncompleteRuns: number
  abandonedIncompleteRuns: number
  researchActionable: number
  researchResearching: number
  telegramPendingConfirm: boolean
  telegramResearchRunning: boolean
  alphaPendingOrProcessing: number
  discordLockHeld: boolean
  discordWorkerLockHeld: boolean
  discordQueued: number
  discordRunning: number
  discordUndeliveredCompleted: number
  xPendingActions: number
  routerIngressPending: number
}>

function countAlphaQueueItems(agentRoot: string): number {
  const root = join(agentRoot, "alpha-queue")
  if (!existsSync(root)) return 0
  let count = 0
  for (const channel of readdirSync(root)) {
    const dir = join(root, channel)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".json")) count += 1
    }
  }
  return count
}

function telegramBusy(home: string): Readonly<{
  pendingConfirm: boolean
  researchRunning: boolean
}> {
  const path = join(home, "pending-research.json")
  const store = filePendingResearchStore(path)
  const file = store.load()
  const pendingConfirm = file.pending !== null
    || file.pendingChoice !== null
    || file.confirmed.some((c) => c.status === "queued" || c.status === "awaiting-choice")
  const researchRunning = file.confirmed.some((c) => c.status === "running")
  return { pendingConfirm, researchRunning }
}

function discordBusy(home: string): Readonly<{
  lockHeld: boolean
  workerLockHeld: boolean
  queued: number
  running: number
  undeliveredCompleted: number
}> {
  const layout = discordLayout(home)
  const lockHeld = existsSync(layout.lock) || existsSync(`${layout.lock}.owner`)
  const workerLockHeld = existsSync(layout.workerLock) || existsSync(`${layout.workerLock}.owner`)
  if (!existsSync(layout.root)) {
    return {
      lockHeld: false,
      workerLockHeld: false,
      queued: 0,
      running: 0,
      undeliveredCompleted: 0,
    }
  }
  const store = createDiscordStore(layout)
  const requests = store.loadRequests()
  let queued = 0
  let running = 0
  let undeliveredCompleted = 0
  for (const r of requests.requests) {
    if (r.status === "queued") queued += 1
    if (r.status === "running") running += 1
    if (r.status === "completed" && r.deliveredPartKeys.length === 0) {
      undeliveredCompleted += 1
    }
  }
  return { lockHeld, workerLockHeld, queued, running, undeliveredCompleted }
}

export async function buildDrainSnapshot(opts: Readonly<{
  agentRoot: string
  archiveRoot: string
  home?: string
  nowIso?: string
  health?: HealthSnapshot
}>): Promise<DrainSnapshot> {
  const home = opts.home ?? join(homedir(), ".trenchcoat")
  const nowIso = opts.nowIso ?? systemClock.nowIso()
  const health = opts.health ?? await buildHealthSnapshot({
    agentRoot: opts.agentRoot,
    archiveRoot: opts.archiveRoot,
    nowIso,
  })
  const layout = archiveLayout(opts.archiveRoot)
  const incomplete = await findIncompleteRunRefs(layout, nowIso)
  const runningIncomplete = incomplete.filter((r) => r.status === "running").length
  const abandonedIncomplete = incomplete.filter((r) => r.status === "abandoned").length
  const router = snapshotBroadcastPipeline(layout, nowIso)
  const discord = discordBusy(home)
  const telegram = telegramBusy(home)

  return {
    capturedAt: nowIso,
    lockHeld: health.lock.held,
    lockStale: health.lock.stale === true,
    incompleteRuns: runningIncomplete,
    runningIncompleteRuns: runningIncomplete,
    abandonedIncompleteRuns: abandonedIncomplete,
    researchActionable: health.research.actionable,
    researchResearching: health.research.researching,
    telegramPendingConfirm: telegram.pendingConfirm,
    telegramResearchRunning: telegram.researchRunning,
    alphaPendingOrProcessing: countAlphaQueueItems(opts.agentRoot),
    discordLockHeld: discord.lockHeld,
    discordWorkerLockHeld: discord.workerLockHeld,
    discordQueued: discord.queued,
    discordRunning: discord.running,
    discordUndeliveredCompleted: discord.undeliveredCompleted,
    xPendingActions: health.x.pendingActions,
    routerIngressPending: router.ingress.ingressPending,
  }
}

/**
 * Safe to restart/redeploy the live agent without interrupting an in-flight
 * Cursor session or host job. Ignores abandoned history and backlog depth.
 */
export function isAgentIdle(snapshot: DrainSnapshot): boolean {
  if (snapshot.lockHeld && !snapshot.lockStale) return false
  if (snapshot.runningIncompleteRuns > 0) return false
  if (snapshot.researchResearching > 0) return false
  if (snapshot.telegramResearchRunning) return false
  if (snapshot.discordLockHeld || snapshot.discordWorkerLockHeld) return false
  if (snapshot.discordRunning > 0) return false
  return true
}

/** Exact all-work drain predicate for agent-workspace activation */
export function isDrainClear(snapshot: DrainSnapshot): boolean {
  if (!isAgentIdle(snapshot)) return false
  if (snapshot.lockStale) return false
  if (snapshot.researchActionable > 0) return false
  if (snapshot.telegramPendingConfirm) return false
  if (snapshot.alphaPendingOrProcessing > 0) return false
  if (snapshot.discordQueued > 0) return false
  if (snapshot.discordUndeliveredCompleted > 0) return false
  if (snapshot.xPendingActions > 0) return false
  if (snapshot.routerIngressPending > 0) return false
  return true
}

export type WaitForAgentIdleOptions = Readonly<{
  agentRoot: string
  archiveRoot: string
  home?: string
  /** Poll interval; default 5s */
  pollMs?: number
  /** Max wait; default 30m. 0 = wait indefinitely */
  timeoutMs?: number
  nowIso?: string
  sleep?: (ms: number) => Promise<void>
  onPoll?: (snapshot: DrainSnapshot) => void | Promise<void>
}>

export type WaitForAgentIdleResult =
  | Readonly<{ ok: true, snapshot: DrainSnapshot, waitedMs: number }>
  | Readonly<{ ok: false, reason: "timeout" | "stale-lock", snapshot: DrainSnapshot, waitedMs: number }>

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms)
})

/**
 * Block until in-flight agent/host work finishes. Does not clear abandoned
 * history or backlog. Stale locks fail closed (operator must heal).
 * Before polling, fails orphaned incomplete journals that block idle.
 */
export async function waitForAgentIdle(
  opts: WaitForAgentIdleOptions,
): Promise<WaitForAgentIdleResult> {
  const pollMs = Math.max(500, opts.pollMs ?? 5_000)
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000
  const sleep = opts.sleep ?? defaultSleep
  const started = Date.now()

  const { abandonOrphanedRuns } = await import("../orchestrator/abandon.js")
  await abandonOrphanedRuns({
    agentRoot: opts.agentRoot,
    archiveRoot: opts.archiveRoot,
    ...(opts.nowIso ? { nowIso: opts.nowIso } : {}),
  })

  for (;;) {
    const snapshot = await buildDrainSnapshot({
      agentRoot: opts.agentRoot,
      archiveRoot: opts.archiveRoot,
      ...(opts.home ? { home: opts.home } : {}),
      ...(opts.nowIso ? { nowIso: opts.nowIso } : {}),
    })
    if (opts.onPoll) await opts.onPoll(snapshot)
    if (snapshot.lockStale) {
      return {
        ok: false,
        reason: "stale-lock",
        snapshot,
        waitedMs: Date.now() - started,
      }
    }
    if (isAgentIdle(snapshot)) {
      return { ok: true, snapshot, waitedMs: Date.now() - started }
    }
    const waitedMs = Date.now() - started
    if (timeoutMs > 0 && waitedMs >= timeoutMs) {
      return { ok: false, reason: "timeout", snapshot, waitedMs }
    }
    await sleep(pollMs)
  }
}

export async function writePendingAgentDeploymentManifest(opts: Readonly<{
  archiveRoot: string
  hypothesisId: string
  sourceCommit: string
  files: AgentDeploymentManifest["files"]
  nowIso?: string
}>): Promise<AgentDeploymentManifest> {
  const manifest = AgentDeploymentManifestSchema.parse({
    schema: 1,
    status: "pending",
    sourceCommit: opts.sourceCommit,
    hypothesisId: opts.hypothesisId,
    files: opts.files,
    createdAt: opts.nowIso ?? systemClock.nowIso(),
  })
  const dir = hypothesisDir(opts.archiveRoot, opts.hypothesisId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  await writeAtomicFile(
    join(dir, "agent-deployment.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    0o600,
  )
  return manifest
}

export type ActivateResult =
  | Readonly<{ ok: true, manifest: AgentDeploymentManifest }>
  | Readonly<{ ok: false, reason: string, deferred?: boolean }>

/**
 * Stage approved agent files, hash-verify, atomically replace under lock.
 * Only proceeds when the drain predicate is clear. Policy-only for this rollout.
 */
export async function activateAgentWorkspace(opts: Readonly<{
  archiveRoot: string
  hypothesisId: string
  repoRoot: string
  agentRoot: string
  sourceCommit: string
  nowIso?: string
  home?: string
  /** Wait for in-flight jobs before syncing; default true */
  waitForIdle?: boolean
  waitTimeoutMs?: number
  waitPollMs?: number
  sleep?: (ms: number) => Promise<void>
  onWaitPoll?: (snapshot: DrainSnapshot) => void | Promise<void>
}>): Promise<ActivateResult> {
  const nowIso = opts.nowIso ?? systemClock.nowIso()
  if (opts.waitForIdle !== false) {
    const waited = await waitForAgentIdle({
      agentRoot: opts.agentRoot,
      archiveRoot: opts.archiveRoot,
      ...(opts.home ? { home: opts.home } : {}),
      ...(opts.waitTimeoutMs !== undefined ? { timeoutMs: opts.waitTimeoutMs } : {}),
      ...(opts.waitPollMs !== undefined ? { pollMs: opts.waitPollMs } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      ...(opts.onWaitPoll ? { onPoll: opts.onWaitPoll } : {}),
    })
    if (!waited.ok) {
      return {
        ok: false,
        reason: waited.reason === "stale-lock"
          ? "stale workspace lock — heal with tc status --heal before activate"
          : "timed out waiting for in-flight agent work",
        deferred: true,
      }
    }
  }
  const snapshot = await buildDrainSnapshot({
    agentRoot: opts.agentRoot,
    archiveRoot: opts.archiveRoot,
    ...(opts.home ? { home: opts.home } : {}),
    nowIso,
  })
  if (!isDrainClear(snapshot)) {
    const sourcePath = join(opts.repoRoot, DECISION_POLICY_REL_PATH)
    if (!existsSync(sourcePath)) {
      return { ok: false, reason: "source policy missing for deferred manifest", deferred: true }
    }
    const sourceHash = sha256Bytes(readFileSync(sourcePath))
    const livePath = join(opts.agentRoot, "skills", "decision-policy", "policy.json")
    const previousHash = existsSync(livePath)
      ? sha256Bytes(readFileSync(livePath))
      : undefined
    await writePendingAgentDeploymentManifest({
      archiveRoot: opts.archiveRoot,
      hypothesisId: opts.hypothesisId,
      sourceCommit: opts.sourceCommit,
      files: [{
        relPath: DECISION_POLICY_REL_PATH,
        sourceHash,
        ...(previousHash ? { previousHash } : {}),
      }],
      nowIso,
    })
    return { ok: false, reason: "drain not clear", deferred: true }
  }

  const lock = new WorkspaceLock(agentLockPath(opts.agentRoot))
  if (!lock.tryAcquire()) {
    return { ok: false, reason: "workspace lock held" }
  }

  const rollbackDir = join(
    hypothesisDir(opts.archiveRoot, opts.hypothesisId),
    "agent-rollback",
  )
  try {
    // Recompute drain under lock
    const again = await buildDrainSnapshot({
      agentRoot: opts.agentRoot,
      archiveRoot: opts.archiveRoot,
      ...(opts.home ? { home: opts.home } : {}),
      nowIso: systemClock.nowIso(),
    })
    if (!isDrainClear(again)) {
      await writePendingAgentDeploymentManifest({
        archiveRoot: opts.archiveRoot,
        hypothesisId: opts.hypothesisId,
        sourceCommit: opts.sourceCommit,
        files: [{
          relPath: DECISION_POLICY_REL_PATH,
          sourceHash: sha256Bytes(readFileSync(join(opts.repoRoot, DECISION_POLICY_REL_PATH))),
        }],
        nowIso,
      })
      return { ok: false, reason: "drain cleared then became busy", deferred: true }
    }

    const relPath = DECISION_POLICY_REL_PATH
    const sourceAbs = join(opts.repoRoot, relPath)
    if (!existsSync(sourceAbs)) {
      return { ok: false, reason: "source policy missing" }
    }
    const sourceHash = sha256Bytes(readFileSync(sourceAbs))
    const liveAbs = join(opts.agentRoot, "skills", "decision-policy", "policy.json")
    mkdirSync(rollbackDir, { recursive: true, mode: 0o700 })
    const previousHash = existsSync(liveAbs)
      ? sha256Bytes(readFileSync(liveAbs))
      : undefined
    if (existsSync(liveAbs)) {
      copyFileSync(liveAbs, join(rollbackDir, "policy.json"))
    }

    const stageDir = join(opts.agentRoot, ".agent-deploy-staging")
    rmSync(stageDir, { recursive: true, force: true })
    mkdirSync(join(stageDir, "skills", "decision-policy"), { recursive: true, mode: 0o700 })
    const staged = join(stageDir, "skills", "decision-policy", "policy.json")
    copyFileSync(sourceAbs, staged)
    const stagedHash = sha256Bytes(readFileSync(staged))
    if (stagedHash !== sourceHash) {
      rmSync(stageDir, { recursive: true, force: true })
      return { ok: false, reason: "staged hash mismatch" }
    }

    mkdirSync(dirname(liveAbs), { recursive: true, mode: 0o700 })
    renameSync(staged, liveAbs)
    rmSync(stageDir, { recursive: true, force: true })

    const liveHash = sha256Bytes(readFileSync(liveAbs))
    if (liveHash !== sourceHash) {
      if (existsSync(join(rollbackDir, "policy.json"))) {
        copyFileSync(join(rollbackDir, "policy.json"), liveAbs)
      }
      return { ok: false, reason: "live hash mismatch after replace" }
    }

    const manifest = AgentDeploymentManifestSchema.parse({
      schema: 1,
      status: "active",
      sourceCommit: opts.sourceCommit,
      hypothesisId: opts.hypothesisId,
      files: [{
        relPath,
        sourceHash,
        ...(previousHash ? { previousHash } : {}),
      }],
      createdAt: nowIso,
      activatedAt: systemClock.nowIso(),
      rollbackSnapshotPath: rollbackDir,
    })
    await writeAtomicFile(
      join(hypothesisDir(opts.archiveRoot, opts.hypothesisId), "agent-deployment.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      0o600,
    )
    return { ok: true, manifest }
  } catch (error) {
    if (existsSync(join(rollbackDir, "policy.json"))) {
      const liveAbs = join(opts.agentRoot, "skills", "decision-policy", "policy.json")
      try {
        copyFileSync(join(rollbackDir, "policy.json"), liveAbs)
      } catch {
        // best-effort restore
      }
    }
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  } finally {
    lock.release()
  }
}

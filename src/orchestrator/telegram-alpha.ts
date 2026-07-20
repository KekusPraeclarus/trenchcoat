import { sanitizePathSegment } from "../lib/snapshot.js"
import { log } from "../lib/log.js"
import { runJob, type RunResult } from "./run.js"

export type TelegramAlphaPaths = Readonly<{
  agentRoot: string
  archiveRoot: string
}>

/**
 * Process one (or a small batch of) newly-accepted alpha-queue message(s)
 * through the full journalled agent pipeline. Lock contention returns exit 3
 * without losing the queue file (INV-Q1).
 */
export async function runTelegramAlphaPass(args: Readonly<{
  paths: TelegramAlphaPaths
  /** Relative paths under agentRoot, e.g. alpha-queue/chan/42.json */
  queuePaths: readonly string[]
  skipAgent?: boolean
}>): Promise<RunResult> {
  const normalized = args.queuePaths.map(normalizeAlphaQueuePath)
  return runJob({
    job: "telegram-alpha",
    paths: args.paths,
    telegramAlphaPaths: normalized,
    ...(args.skipAgent ? { skipAgent: true } : {}),
  })
}

export function alphaQueueRelativePath(channel: string, messageId: string): string {
  return `alpha-queue/${sanitizePathSegment(channel)}/${sanitizePathSegment(messageId)}.json`
}

function normalizeAlphaQueuePath(path: string): string {
  const trimmed = path.replace(/^\/+/u, "").replace(/\\/gu, "/")
  if (!trimmed.startsWith("alpha-queue/")) {
    throw new Error(`telegram-alpha path must be under alpha-queue/: ${path}`)
  }
  if (trimmed.includes("..")) {
    throw new Error(`telegram-alpha path escapes: ${path}`)
  }
  return trimmed
}

/**
 * Serial pump: enqueue message paths and process one runJob at a time so the
 * channels listener never blocks on the agent, and INV-S15 is respected.
 */
export function createTelegramAlphaPump(args: Readonly<{
  paths: TelegramAlphaPaths
  runPass?: typeof runTelegramAlphaPass
  onIdle?: () => void
  /** Injectable lock-retry sleep (default 15s) */
  lockRetryMs?: number
  sleep?: (ms: number) => Promise<void>
}>): Readonly<{
  enqueue: (queuePath: string) => void
  pending: () => number
  drain: () => Promise<void>
}> {
  const queue: string[] = []
  const seen = new Set<string>()
  let running = false
  const runPass = args.runPass ?? runTelegramAlphaPass
  const lockRetryMs = args.lockRetryMs ?? 15_000
  const sleep = args.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  const pump = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      while (queue.length > 0) {
        const next = queue.shift()!
        seen.delete(next)
        try {
          const result = await runPass({
            paths: args.paths,
            queuePaths: [next],
          })
          if (result.exitCode === 3) {
            // Lock held — requeue and pause briefly
            if (!seen.has(next)) {
              queue.push(next)
              seen.add(next)
            }
            log.warn("telegram-alpha busy — will retry", { path: next })
            await sleep(lockRetryMs)
            continue
          }
          if (result.exitCode !== 0) {
            log.error("telegram-alpha pass failed", {
              path: next,
              exitCode: result.exitCode,
              runId: result.runId,
            })
          } else {
            log.info("telegram-alpha pass complete", {
              path: next,
              runId: result.runId,
            })
          }
        } catch (error) {
          log.error("telegram-alpha pass threw", {
            path: next,
            detail: error instanceof Error ? error.message : "unknown",
          })
        }
      }
    } finally {
      running = false
      args.onIdle?.()
    }
  }

  return {
    enqueue: (queuePath: string) => {
      const normalized = normalizeAlphaQueuePath(queuePath)
      if (seen.has(normalized)) return
      seen.add(normalized)
      queue.push(normalized)
      void pump()
    },
    pending: () => queue.length + (running ? 1 : 0),
    drain: () => pump(),
  }
}

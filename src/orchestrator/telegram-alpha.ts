import { homedir } from "node:os"
import { join } from "node:path"
import { sanitizePathSegment } from "../lib/snapshot.js"
import { isDeployPaused } from "../lib/deploy-pause.js"
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
 * Serial pump: enqueue message paths and process up to TELEGRAM_ALPHA_BATCH_SIZE
 * per runJob so the channels listener never blocks on the agent, and INV-S15
 * is respected.
 */
export const TELEGRAM_ALPHA_BATCH_SIZE = 8

export function createTelegramAlphaPump(args: Readonly<{
  paths: TelegramAlphaPaths
  runPass?: typeof runTelegramAlphaPass
  onIdle?: () => void
  /** Injectable lock-retry sleep (default 15s) */
  lockRetryMs?: number
  sleep?: (ms: number) => Promise<void>
  batchSize?: number
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
  const batchSize = Math.max(1, args.batchSize ?? TELEGRAM_ALPHA_BATCH_SIZE)

  const pump = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      while (queue.length > 0) {
        // Yield so synchronous burst enqueues coalesce into one batch
        await Promise.resolve()
        if (queue.length === 0) break
        const batch: string[] = []
        while (batch.length < batchSize && queue.length > 0) {
          const next = queue.shift()!
          seen.delete(next)
          batch.push(next)
        }
        try {
          const result = await runPass({
            paths: args.paths,
            queuePaths: batch,
          })
          if (result.exitCode === 3) {
            // Lock held or deploy pause — requeue whole batch and pause briefly
            for (const path of batch) {
              if (!seen.has(path)) {
                queue.push(path)
                seen.add(path)
              }
            }
            const home = join(homedir(), ".trenchcoat")
            if (isDeployPaused(home)) {
              log.warn("telegram-alpha deferred for deploy pause", { paths: batch.join(",") })
              while (isDeployPaused(home)) {
                await sleep(5_000)
              }
              continue
            }
            log.warn("telegram-alpha busy — will retry", { paths: batch.join(",") })
            await sleep(lockRetryMs)
            continue
          }
          if (result.exitCode !== 0) {
            log.error("telegram-alpha pass failed", {
              paths: batch.join(","),
              exitCode: result.exitCode,
              runId: result.runId,
            })
          } else {
            log.info("telegram-alpha pass complete", {
              paths: batch.join(","),
              count: batch.length,
              runId: result.runId,
            })
          }
        } catch (error) {
          log.error("telegram-alpha pass threw", {
            paths: batch.join(","),
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

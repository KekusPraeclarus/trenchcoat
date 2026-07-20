import { loadConfig } from "../lib/config.js"
import { log } from "../lib/log.js"
import { systemClock } from "../lib/clock.js"
import {
  isBrowserClosedError,
  openPersistentReadOnlyTwitter,
  resolveTwitterTargets,
  scrapeTargetUntilCursor,
  type PersistentTwitterSession,
  type TwitterScrapeBundle,
  type TwitterScrapeTarget,
} from "../collectors/twitter/scrape.js"
import { runJob, type RunResult } from "./run.js"
import {
  advanceXScanCursor,
  loadXScanCursors,
  markXScanRoundComplete,
  randomRoundDelayMs,
  xScanCursorsPath,
  X_SCAN_ROUND_DELAY_MAX_MS,
  X_SCAN_ROUND_DELAY_MIN_MS,
} from "./x-scan-cursors.js"

export type XScanLoopPaths = Readonly<{
  agentRoot: string
  archiveRoot: string
}>

export type XScanLoopOptions = Readonly<{
  paths: XScanLoopPaths
  home?: string
  signal?: AbortSignal
  headless?: boolean
  /** Injectable delay between completed rounds (tests) */
  roundDelayMs?: () => number
  /** Injectable sleep (tests) */
  sleep?: (ms: number) => Promise<void>
  /** Injectable target runner (tests) */
  runTarget?: (args: Readonly<{
    target: TwitterScrapeTarget
    bundle: TwitterScrapeBundle
  }>) => Promise<RunResult>
  openSession?: () => Promise<PersistentTwitterSession>
  /** Injectable scrape (tests) — defaults to scrapeTargetUntilCursor */
  scrape?: typeof scrapeTargetUntilCursor
  /** Injectable target list (tests) */
  resolveTargets?: () => TwitterScrapeTarget[]
  /** Override max scroll pages (tests / streaming) */
  maxPages?: number
  maxLockRetries?: number
  lockRetryMs?: number
}>

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(new Error("aborted"))
    }, { once: true })
  })
}

async function runListScanWithLockRetry(args: Readonly<{
  paths: XScanLoopPaths
  bundle: TwitterScrapeBundle
  maxLockRetries: number
  lockRetryMs: number
  sleep: (ms: number) => Promise<void>
  runTarget?: XScanLoopOptions["runTarget"]
  target: TwitterScrapeTarget
}>): Promise<RunResult> {
  for (let attempt = 0; attempt <= args.maxLockRetries; attempt += 1) {
    const result = args.runTarget
      ? await args.runTarget({ target: args.target, bundle: args.bundle })
      : await runJob({
        job: "list-scan",
        paths: args.paths,
        listScanOverride: {
          bundles: [args.bundle],
          includeAlphaManifest: false,
        },
      })
    if (result.exitCode !== 3) return result
    if (attempt === args.maxLockRetries) return result
    log.warn("x-scan waiting for workspace lock", {
      target: args.target.label,
      attempt: attempt + 1,
    })
    await args.sleep(args.lockRetryMs)
  }
  throw new Error("unreachable")
}

/**
 * Persistent FYP → lists round-robin. Keeps one Playwright session alive,
 * scrolls each target until the last-read post, runs list-scan per target,
 * then sleeps a random 5–30 minutes before the next round.
 */
export async function runXScanLoop(opts: XScanLoopOptions): Promise<void> {
  const cursorsFile = xScanCursorsPath(opts.home)
  const sleep = opts.sleep ?? ((ms: number) => defaultSleep(ms, opts.signal))
  const maxLockRetries = opts.maxLockRetries ?? 60
  const lockRetryMs = opts.lockRetryMs ?? 10_000
  const roundDelay = opts.roundDelayMs ?? (() => randomRoundDelayMs(
    X_SCAN_ROUND_DELAY_MIN_MS,
    X_SCAN_ROUND_DELAY_MAX_MS,
  ))
  const resolveTargets = opts.resolveTargets
    ?? (() => resolveTwitterTargets(loadConfig()))

  const open = opts.openSession ?? (() => openPersistentReadOnlyTwitter({
    headless: opts.headless !== false,
  }))
  let session = await open()
  let relaunches = 0

  log.info("x-scan loop starting", {
    targets: resolveTargets().map((t) => t.label).join(","),
    cursorsFile,
  })

  try {
    while (!opts.signal?.aborted) {
      const targets = resolveTargets()
      const cursors = loadXScanCursors(cursorsFile)
      const scrape = opts.scrape ?? scrapeTargetUntilCursor
      const maxPages = opts.maxPages ?? loadConfig().twitter.max_pages_per_run

      for (const target of targets) {
        if (opts.signal?.aborted) break
        const stopAtPostId = cursors.targets[target.label]?.lastPostId

        let scraped: Awaited<ReturnType<typeof scrapeTargetUntilCursor>> | undefined
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            scraped = await scrape(session.page(), target, {
              maxPages,
              ...(stopAtPostId ? { stopAtPostId } : {}),
            })
            break
          } catch (error) {
            if (!isBrowserClosedError(error) || attempt > 0) throw error
            relaunches += 1
            log.warn("x-scan browser died — relaunching", {
              target: target.label,
              relaunches,
            })
            await session.relaunch()
          }
        }
        if (!scraped) continue

        if (scraped.bundle.challenged) {
          log.error("x-scan challenge detected — needs headful re-auth", {
            target: target.label,
          })
          // Back off hard so we do not hammer a locked account
          await sleep(30 * 60 * 1_000).catch(() => undefined)
          break
        }

        if (scraped.bundle.posts.length === 0) {
          log.info("x-scan target idle", {
            target: target.label,
            hitCursor: scraped.hitCursor,
            pagesScrolled: scraped.pagesScrolled,
          })
          // Refresh cursor to newest even when nothing new past stop point
          if (scraped.newestPostId) {
            await advanceXScanCursor({
              cursorsPath: cursorsFile,
              targetLabel: target.label,
              lastPostId: scraped.newestPostId,
              nowIso: systemClock.nowIso(),
            })
          }
          continue
        }

        log.info("x-scan target ready", {
          target: target.label,
          posts: scraped.bundle.posts.length,
          hitCursor: scraped.hitCursor,
          newestPostId: scraped.newestPostId,
        })

        const result = await runListScanWithLockRetry({
          paths: opts.paths,
          target,
          bundle: scraped.bundle,
          maxLockRetries,
          lockRetryMs,
          sleep,
          ...(opts.runTarget ? { runTarget: opts.runTarget } : {}),
        })

        if (result.exitCode === 0 && scraped.newestPostId) {
          await advanceXScanCursor({
            cursorsPath: cursorsFile,
            targetLabel: target.label,
            lastPostId: scraped.newestPostId,
            nowIso: systemClock.nowIso(),
          })
        } else if (result.exitCode !== 0) {
          log.warn("x-scan target run failed", {
            target: target.label,
            exitCode: result.exitCode,
            runId: result.runId,
          })
        }
      }

      if (opts.signal?.aborted) break
      await markXScanRoundComplete({
        cursorsPath: cursorsFile,
        nowIso: systemClock.nowIso(),
      })
      const delayMs = roundDelay()
      log.info("x-scan round complete — sleeping", { delayMs })
      try {
        await sleep(delayMs)
      } catch {
        break
      }
    }
  } finally {
    await session.close().catch(() => undefined)
  }
}

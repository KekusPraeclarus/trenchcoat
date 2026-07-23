import { loadConfig } from "../lib/config.js"
import { log } from "../lib/log.js"
import { systemClock } from "../lib/clock.js"
import { isDeployPaused } from "../lib/deploy-pause.js"
import { homedir } from "node:os"
import { join } from "node:path"
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
import { loadDeploymentManifest } from "../lib/deployment.js"
import {
  appendSourceHealthObservation,
  classifyXScanObservation,
} from "../remediation/source-health.js"
import {
  createRemediationStore,
} from "../remediation/store.js"
import { remediationLayout } from "../remediation/paths.js"
import { listPendingAlphaPaths } from "./review-collect.js"

export type XScanLoopPaths = Readonly<{
  agentRoot: string
  archiveRoot: string
}>

export type XScanPendingCursor = Readonly<{
  label: string
  newestPostId: string
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
  /** Injectable batched list-scan runner (tests) */
  runTarget?: (args: Readonly<{
    bundles: readonly TwitterScrapeBundle[]
    pendingCursorAdvances: readonly XScanPendingCursor[]
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
  bundles: readonly TwitterScrapeBundle[]
  pendingCursorAdvances: readonly XScanPendingCursor[]
  maxLockRetries: number
  lockRetryMs: number
  sleep: (ms: number) => Promise<void>
  runTarget?: XScanLoopOptions["runTarget"]
}>): Promise<RunResult> {
  for (let attempt = 0; attempt <= args.maxLockRetries; attempt += 1) {
    const result = args.runTarget
      ? await args.runTarget({
        bundles: args.bundles,
        pendingCursorAdvances: args.pendingCursorAdvances,
      })
      : await runJob({
        job: "list-scan",
        paths: args.paths,
        listScanOverride: {
          bundles: args.bundles,
          includeAlphaManifest: true,
        },
      })
    if (result.exitCode !== 3) return result
    if (attempt === args.maxLockRetries) return result
    log.warn("x-scan waiting for workspace lock", {
      bundles: args.bundles.map((b) => b.target.label).join(","),
      attempt: attempt + 1,
    })
    await args.sleep(args.lockRetryMs)
  }
  throw new Error("unreachable")
}

/**
 * Persistent FYP → lists round-robin. Keeps one Playwright session alive,
 * scrolls each target until the last-read post, runs one batched list-scan
 * per round, then sleeps a random 5–30 minutes before the next round.
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
      const home = opts.home ?? join(homedir(), ".trenchcoat")
      while (isDeployPaused(home) && !opts.signal?.aborted) {
        log.info("x-scan paused for deploy")
        await sleep(5_000).catch(() => undefined)
      }
      if (opts.signal?.aborted) break

      const targets = resolveTargets()
      const cursors = loadXScanCursors(cursorsFile)
      const scrape = opts.scrape ?? scrapeTargetUntilCursor
      const maxPages = opts.maxPages ?? loadConfig().twitter.max_pages_per_run
      const bundles: TwitterScrapeBundle[] = []
      const pendingCursorAdvances: XScanPendingCursor[] = []
      let challengedBreak = false

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

        // Host-owned source-quality observation (INV-S28) — never blocks the loop
        try {
          const nowIso = systemClock.nowIso()
          const deploy = loadDeploymentManifest()
          const observation = classifyXScanObservation({
            targetKind: target.kind,
            targetLabel: target.label,
            observedAt: nowIso,
            postCount: scraped.bundle.posts.length,
            hitCursor: scraped.hitCursor,
            challenged: scraped.bundle.challenged === true,
            pagesScrolled: scraped.pagesScrolled,
            roundId: nowIso,
            ...(deploy?.sourceCommit ? { sourceCommit: deploy.sourceCommit } : {}),
          })
          const layout = remediationLayout(home)
          const store = createRemediationStore(layout)
          const ledger = store.loadSourceHealthLedger()
          await store.saveSourceHealthLedger(
            appendSourceHealthObservation(ledger, observation),
          )
        } catch (error) {
          log.warn("x-scan source-health write failed", {
            target: target.label,
            error: error instanceof Error ? error.message : String(error),
          })
        }

        if (scraped.bundle.challenged) {
          log.error("x-scan challenge detected — needs headful re-auth", {
            target: target.label,
          })
          // Back off hard so we do not hammer a locked account
          await sleep(30 * 60 * 1_000).catch(() => undefined)
          challengedBreak = true
          break
        }

        if (scraped.bundle.posts.length === 0) {
          // hitCursor=false after scrolling means zero articles parsed — not a caught-up feed
          if (!scraped.hitCursor) {
            log.warn("x-scan target empty without cursor — likely hydration/tab miss", {
              target: target.label,
              pagesScrolled: scraped.pagesScrolled,
            })
          } else {
            log.info("x-scan target idle", {
              target: target.label,
              hitCursor: true,
              pagesScrolled: scraped.pagesScrolled,
            })
          }
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
        bundles.push(scraped.bundle)
        if (scraped.newestPostId) {
          pendingCursorAdvances.push({
            label: target.label,
            newestPostId: scraped.newestPostId,
          })
        }
      }

      if (opts.signal?.aborted) break

      const alphaPending = listPendingAlphaPaths(opts.paths.agentRoot).length
      if (!challengedBreak && (bundles.length > 0 || alphaPending > 0)) {
        log.info("x-scan batched list-scan", {
          bundles: bundles.map((b) => b.target.label).join(",") || "(none)",
          posts: bundles.reduce((n, b) => n + b.posts.length, 0),
          alphaPending,
        })
        const result = await runListScanWithLockRetry({
          paths: opts.paths,
          bundles,
          pendingCursorAdvances,
          maxLockRetries,
          lockRetryMs,
          sleep,
          ...(opts.runTarget ? { runTarget: opts.runTarget } : {}),
        })

        if (result.exitCode === 0) {
          const nowIso = systemClock.nowIso()
          for (const pending of pendingCursorAdvances) {
            await advanceXScanCursor({
              cursorsPath: cursorsFile,
              targetLabel: pending.label,
              lastPostId: pending.newestPostId,
              nowIso,
            })
          }
        } else {
          log.warn("x-scan batched run failed", {
            exitCode: result.exitCode,
            runId: result.runId,
            bundles: bundles.map((b) => b.target.label).join(","),
          })
        }
      } else if (!challengedBreak) {
        log.info("x-scan round idle — no posts and no alpha backlog")
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

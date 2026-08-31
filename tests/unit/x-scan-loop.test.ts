import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Page } from "playwright"
import {
  advanceXScanCursor,
  loadXScanCursors,
  markXScanRoundComplete,
  randomRoundDelayMs,
  X_SCAN_ROUND_DELAY_MAX_MS,
  X_SCAN_ROUND_DELAY_MIN_MS,
  xScanCursorsPath,
} from "../../src/orchestrator/x-scan-cursors.js"
import { runXScanLoop } from "../../src/orchestrator/x-scan-loop.js"
import type { PersistentTwitterSession, TwitterScrapeTarget } from "../../src/collectors/twitter/scrape.js"
import {
  loadXSessionHold,
  saveXSessionHold,
  xSessionHoldPath,
} from "../../src/collectors/twitter/session-hold.js"

function stubSession(
  extras: Partial<PersistentTwitterSession> = {},
): PersistentTwitterSession {
  return {
    page: () => ({}) as Page,
    close: async () => undefined,
    relaunch: async () => ({}) as Page,
    persistStorageState: async () => undefined,
    ...extras,
  }
}

const targets: TwitterScrapeTarget[] = [
  { kind: "home", url: "https://x.com/home", label: "home/fyp" },
  { kind: "operator-list", url: "https://x.com/i/lists/1", label: "operator-list-1" },
  { kind: "managed-list", url: "https://x.com/i/lists/2", label: "managed-list" },
]

describe("x-scan cursors", () => {
  it("persists per-target lastPostId and round completion", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-xscan-"))
    const path = xScanCursorsPath(home)
    await advanceXScanCursor({
      cursorsPath: path,
      targetLabel: "home/fyp",
      lastPostId: "111",
      nowIso: "2026-07-20T12:00:00.000Z",
    })
    await advanceXScanCursor({
      cursorsPath: path,
      targetLabel: "operator-list-1",
      lastPostId: "222",
      nowIso: "2026-07-20T12:01:00.000Z",
    })
    await markXScanRoundComplete({
      cursorsPath: path,
      nowIso: "2026-07-20T12:05:00.000Z",
    })
    const loaded = loadXScanCursors(path)
    expect(loaded.targets["home/fyp"]?.lastPostId).toBe("111")
    expect(loaded.targets["operator-list-1"]?.lastPostId).toBe("222")
    expect(loaded.lastRoundCompletedAt).toBe("2026-07-20T12:05:00.000Z")
  })

  it("bounds round delay to 5–30 minutes", () => {
    expect(X_SCAN_ROUND_DELAY_MIN_MS).toBe(5 * 60 * 1_000)
    expect(X_SCAN_ROUND_DELAY_MAX_MS).toBe(30 * 60 * 1_000)
    expect(randomRoundDelayMs(5_000, 30_000, () => 0)).toBe(5_000)
    expect(randomRoundDelayMs(5_000, 30_000, () => 0.999999)).toBe(30_000)
    for (let i = 0; i < 50; i += 1) {
      const v = randomRoundDelayMs(
        X_SCAN_ROUND_DELAY_MIN_MS,
        X_SCAN_ROUND_DELAY_MAX_MS,
      )
      expect(v).toBeGreaterThanOrEqual(X_SCAN_ROUND_DELAY_MIN_MS)
      expect(v).toBeLessThanOrEqual(X_SCAN_ROUND_DELAY_MAX_MS)
    }
  })
})

describe("x-scan loop", () => {
  it("processes FYP then lists, advances cursors, then delays", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-xloop-"))
    const cursorsFile = xScanCursorsPath(root)
    const order: string[] = []
    let rounds = 0
    const ac = new AbortController()

    await runXScanLoop({
      paths: { agentRoot: root, archiveRoot: join(root, "archive") },
      home: root,
      signal: ac.signal,
      resolveTargets: () => targets,
      maxPages: 2,
      roundDelayMs: () => 5,
      sleep: async () => {
        rounds += 1
        if (rounds >= 1) ac.abort()
      },
      openSession: async () => stubSession(),
      scrape: async (_page, target) => ({
        bundle: {
          target,
          challenged: false,
          posts: [{
            id: `${target.label}-new`,
            author: "alice",
            text: "signal",
            url: "https://x.com/a/1",
            timestamp: "2026-07-20T10:00:00.000Z",
            provenance: "twitter:@alice:1",
            engagement: { likes: 0, views: 0 },
          }],
        },
        newestPostId: `${target.label}-new`,
        hitCursor: false,
        pagesScrolled: 1,
      }),
      runTarget: async ({ bundles }) => {
        for (const bundle of bundles) {
          order.push(bundle.target.label)
        }
        return {
          runId: "run-batched",
          journal: {
            schema: 1,
            runId: "run-batched",
            job: "list-scan",
            phase: "complete",
            createdAt: "2026-07-20T10:00:00.000Z",
            updatedAt: "2026-07-20T10:00:00.000Z",
            sideEffects: [],
          } as never,
          exitCode: 0,
        }
      },
    })

    expect(order).toEqual(["home/fyp", "operator-list-1", "managed-list"])
    const cursors = loadXScanCursors(cursorsFile)
    expect(cursors.targets["home/fyp"]?.lastPostId).toBe("home/fyp-new")
    expect(cursors.targets["operator-list-1"]?.lastPostId).toBe("operator-list-1-new")
    expect(cursors.lastRoundCompletedAt).toBeTruthy()
  })

  it("runs one batched list-scan per round", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-xbatch-"))
    const ac = new AbortController()
    let runCalls = 0
    let bundleCount = 0
    await runXScanLoop({
      paths: { agentRoot: root, archiveRoot: join(root, "archive") },
      home: root,
      signal: ac.signal,
      resolveTargets: () => targets,
      maxPages: 2,
      roundDelayMs: () => 5,
      sleep: async () => {
        ac.abort()
      },
      openSession: async () => stubSession(),
      scrape: async (_page, target) => ({
        bundle: {
          target,
          challenged: false,
          posts: [{
            id: `${target.label}-new`,
            author: "alice",
            text: "signal",
            url: "https://x.com/a/1",
            timestamp: "2026-07-20T10:00:00.000Z",
            provenance: "twitter:@alice:1",
            engagement: { likes: 0, views: 0 },
          }],
        },
        newestPostId: `${target.label}-new`,
        hitCursor: false,
        pagesScrolled: 1,
      }),
      runTarget: async ({ bundles }) => {
        runCalls += 1
        bundleCount = bundles.length
        return {
          runId: "run-batched",
          journal: {
            schema: 1,
            runId: "run-batched",
            job: "list-scan",
            phase: "complete",
            createdAt: "2026-07-20T10:00:00.000Z",
            updatedAt: "2026-07-20T10:00:00.000Z",
            sideEffects: [],
          } as never,
          exitCode: 0,
        }
      },
    })
    expect(runCalls).toBe(1)
    expect(bundleCount).toBe(3)
  })

  it("passes stopAtPostId from persisted cursor", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-xloop2-"))
    await advanceXScanCursor({
      cursorsPath: xScanCursorsPath(root),
      targetLabel: "home/fyp",
      lastPostId: "old-fyp",
      nowIso: "2026-07-20T09:00:00.000Z",
    })
    const ac = new AbortController()
    let seenStop: string | undefined
    await runXScanLoop({
      paths: { agentRoot: root, archiveRoot: join(root, "archive") },
      home: root,
      signal: ac.signal,
      resolveTargets: () => [targets[0]!],
      maxPages: 2,
      roundDelayMs: () => 1,
      sleep: async () => {
        ac.abort()
      },
      openSession: async () => stubSession(),
      scrape: async (_page, target, opts) => {
        seenStop = opts.stopAtPostId
        return {
          bundle: { target, posts: [], challenged: false },
          newestPostId: "old-fyp",
          hitCursor: true,
          pagesScrolled: 1,
        }
      },
      runTarget: async () => {
        throw new Error("should not run agent on empty posts")
      },
    })
    expect(seenStop).toBe("old-fyp")
  })

  it("retries when workspace lock is held", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-xlock-"))
    const ac = new AbortController()
    let attempts = 0
    await runXScanLoop({
      paths: { agentRoot: root, archiveRoot: join(root, "archive") },
      home: root,
      signal: ac.signal,
      resolveTargets: () => [targets[0]!],
      maxPages: 2,
      maxLockRetries: 2,
      lockRetryMs: 1,
      roundDelayMs: () => 1,
      sleep: async () => {
        ac.abort()
      },
      openSession: async () => stubSession(),
      scrape: async (_page, target) => ({
        bundle: {
          target,
          challenged: false,
          posts: [{
            id: "p1",
            author: "a",
            text: "t",
            url: "u",
            timestamp: "2026-07-20T10:00:00.000Z",
            provenance: "twitter:@a:p1",
            engagement: { likes: 0, views: 0 },
          }],
        },
        newestPostId: "p1",
        hitCursor: false,
        pagesScrolled: 1,
      }),
      runTarget: async () => {
        attempts += 1
        return {
          runId: "none",
          journal: {
            schema: 1,
            runId: "none",
            job: "list-scan",
            phase: "complete",
            createdAt: "",
            updatedAt: "",
            sideEffects: [],
          } as never,
          exitCode: attempts < 2 ? 3 : 0,
        }
      },
    })
    expect(attempts).toBe(2)
  })

  it("parks without opening a browser when a session hold exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-xhold-"))
    await saveXSessionHold({
      path: xSessionHoldPath(root),
      heldAt: "2026-08-28T13:37:06.707Z",
      target: "home/fyp",
    })
    const ac = new AbortController()
    let opened = 0
    await runXScanLoop({
      paths: { agentRoot: root, archiveRoot: join(root, "archive") },
      home: root,
      signal: ac.signal,
      resolveTargets: () => [targets[0]!],
      holdPollMs: 1,
      sleep: async () => {
        ac.abort()
      },
      openSession: async () => {
        opened += 1
        return stubSession()
      },
      scrape: async () => {
        throw new Error("must not scrape while held")
      },
      runTarget: async () => {
        throw new Error("must not run list-scan while held")
      },
    })
    expect(opened).toBe(0)
  })

  it("writes a session hold on challenge and skips list-scan", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-xchal-"))
    const ac = new AbortController()
    let runCalls = 0
    let persistCalls = 0
    await runXScanLoop({
      paths: { agentRoot: root, archiveRoot: join(root, "archive") },
      home: root,
      signal: ac.signal,
      resolveTargets: () => [targets[0]!],
      holdPollMs: 1,
      sleep: async () => {
        ac.abort()
      },
      openSession: async () => stubSession({
        persistStorageState: async () => {
          persistCalls += 1
        },
      }),
      scrape: async (_page, target) => ({
        bundle: { target, posts: [], challenged: true },
        hitCursor: false,
        pagesScrolled: 0,
      }),
      runTarget: async () => {
        runCalls += 1
        return {
          runId: "none",
          journal: {
            schema: 1,
            runId: "none",
            job: "list-scan",
            phase: "complete",
            createdAt: "",
            updatedAt: "",
            sideEffects: [],
          } as never,
          exitCode: 0,
        }
      },
    })
    const hold = loadXSessionHold(xSessionHoldPath(root))
    expect(hold?.reason).toBe("challenge")
    expect(hold?.target).toBe("home/fyp")
    expect(runCalls).toBe(0)
    expect(persistCalls).toBe(0)
  })

  it("persists storage state after a healthy scrape round", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-xpersist-"))
    const ac = new AbortController()
    let persistCalls = 0
    await runXScanLoop({
      paths: { agentRoot: root, archiveRoot: join(root, "archive") },
      home: root,
      signal: ac.signal,
      resolveTargets: () => [targets[0]!],
      maxPages: 1,
      roundDelayMs: () => 1,
      sleep: async () => {
        ac.abort()
      },
      openSession: async () => stubSession({
        persistStorageState: async () => {
          persistCalls += 1
        },
      }),
      scrape: async (_page, target) => ({
        bundle: {
          target,
          challenged: false,
          posts: [{
            id: "p1",
            author: "a",
            text: "t",
            url: "u",
            timestamp: "2026-07-20T10:00:00.000Z",
            provenance: "twitter:@a:p1",
            engagement: { likes: 0, views: 0 },
          }],
        },
        newestPostId: "p1",
        hitCursor: true,
        pagesScrolled: 1,
      }),
      runTarget: async () => ({
        runId: "run-persist",
        journal: {
          schema: 1,
          runId: "run-persist",
          job: "list-scan",
          phase: "complete",
          createdAt: "2026-07-20T10:00:00.000Z",
          updatedAt: "2026-07-20T10:00:00.000Z",
          sideEffects: [],
        } as never,
        exitCode: 0,
      }),
    })
    expect(persistCalls).toBe(1)
  })
})

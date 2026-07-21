import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive, runArchiveDir } from "../../src/lib/archive.js"
import { StateStore } from "../../src/lib/state.js"
import { createJournalStore } from "../../src/orchestrator/journal-store.js"
import {
  buildHealthSnapshot,
  formatHealthText,
  healthCreatesReviewScope,
  healthSnapshotLines,
  skipLedgerLines,
  toHealthJsonPayload,
} from "../../src/orchestrator/health.js"
import { recordJobSkip } from "../../src/orchestrator/preconditions.js"

const NOW = "2026-07-18T12:00:00.000Z"

async function seedCompleteRun(args: Readonly<{
  layout: Awaited<ReturnType<typeof ensureArchive>>
  agentRoot: string
  runId: string
  job: string
  createdAt: string
  failed?: boolean
  collectorSkip?: boolean
  fcReceipt?: Record<string, unknown>
}>): Promise<void> {
  const store = createJournalStore(args.layout)
  await store.save({
    schema: 1,
    runId: args.runId,
    phase: "complete",
    status: args.failed ? "failed" : "complete",
    phaseHashes: {},
    sideEffects: {},
    ...(args.failed
      ? {
        failure: {
          lastPhase: "collected" as const,
          code: "test-fail",
          message: "fixture",
          failedAt: args.createdAt,
        },
      }
      : {}),
  })

  const runDir = runArchiveDir(args.layout, args.runId)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, "manifest.json"), `${JSON.stringify({
    schema: 1,
    runId: args.runId,
    job: args.job,
    createdAt: args.createdAt,
    inboxManifest: {},
    fileHashes: {},
  }, null, 2)}\n`)

  if (args.collectorSkip) {
    const reportDir = join(args.agentRoot, "reports", args.runId)
    mkdirSync(reportDir, { recursive: true })
    writeFileSync(join(reportDir, "collector-skip.json"), `${JSON.stringify({
      schema: 1,
      runId: args.runId,
      job: args.job,
      status: "collector-skip",
    }, null, 2)}\n`)
  }

  if (args.fcReceipt) {
    const inboxDir = join(runDir, "inbox")
    mkdirSync(inboxDir, { recursive: true })
    writeFileSync(join(inboxDir, "farcaster-collection-receipt.json"), `${JSON.stringify({
      source: "host.collector",
      fetchedAt: args.createdAt,
      trust: "untrusted-external",
      items: [{
        provenance: `${args.runId}:fc-receipt`,
        text: JSON.stringify(args.fcReceipt),
        ts: args.createdAt,
        ageSec: 0,
        freshnessTier: "live",
      }],
    }, null, 2)}\n`)
  }
}

describe("buildHealthSnapshot", () => {
  it("aggregates lock, skips, research depth, wallets, and router ingress", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-health-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    const layout = await ensureArchive(archiveRoot)

    const state = new StateStore(join(agentRoot, "state"))
    await state.saveWatchlist({ schema: 1, entries: [] })
    await state.saveResearchQueue({
      schema: 1,
      entries: [{
        schema: 1,
        queueId: "rq-1",
        subject: "solana:So11111111111111111111111111111111111111112",
        chain: "solana",
        tokenAddress: "So11111111111111111111111111111111111111112",
        symbolDisplay: "SOL",
        resolution: "ambiguous",
        priority: 10,
        firstSeen: NOW,
        enqueuedAt: NOW,
        enqueuedBy: "rr-1",
        trigger: "narrative",
        expiresAt: "2026-08-01T00:00:00.000Z",
        provenance: ["test"],
        clusterCount: 1,
        security: { status: "pending", flags: [] },
        status: "ambiguous",
        reason: "fixture ambiguous",
      }],
    })
    await state.saveWallets({ schema: 1, wallets: [], transitions: [], pendingTransitionIds: [], cursors: [], exclusions: [] })
    await state.saveXEngagement({
      schema: 1,
      likedPostIds: [],
      followedHandles: [],
      lastLikedAt: {},
      lastFollowedAt: {},
      pendingActionIds: [
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ],
      decisions: [],
      receipts: [],
      daily: { day: "2026-07-18", likes: 0, follows: 0, unfollows: 0 },
    })
    await state.saveXBotHealth({
      schema: 1,
      updatedAt: NOW,
      consecutiveFailures: 3,
    })

    writeFileSync(join(agentRoot, ".lock.owner"), "999999\n")

    await recordJobSkip({
      job: "research",
      reason: "queue-empty",
      archiveRoot,
      skippedAt: "2026-07-18T11:00:00.000Z",
    })
    await recordJobSkip({
      job: "research",
      reason: "queue-empty",
      archiveRoot,
      skippedAt: "2026-07-18T11:30:00.000Z",
    })
    await recordJobSkip({
      job: "research",
      reason: "queue-empty",
      archiveRoot,
      skippedAt: "2026-07-18T11:45:00.000Z",
    })

    await seedCompleteRun({
      layout,
      agentRoot,
      runId: "list-scan-2026-07-18T10-00-00-000Z",
      job: "list-scan",
      createdAt: "2026-07-18T10:00:00.000Z",
    })
    await seedCompleteRun({
      layout,
      agentRoot,
      runId: "farcaster-scan-2026-07-18T09-00-00-000Z",
      job: "farcaster-scan",
      createdAt: "2026-07-18T09:00:00.000Z",
      fcReceipt: {
        schema: 1,
        fallbackUsed: true,
        usableEvidenceCount: 0,
        engagementDisabled: true,
        skipAgent: true,
        feeds: [{
          target: { kind: "for_you" },
          rejected: true,
          rejectReason: "repeated_two_hash_stale",
        }],
      },
    })
    await seedCompleteRun({
      layout,
      agentRoot,
      runId: "farcaster-scan-2026-07-18T08-00-00-000Z",
      job: "farcaster-scan",
      createdAt: "2026-07-18T08:00:00.000Z",
      fcReceipt: {
        schema: 1,
        fallbackUsed: true,
        usableEvidenceCount: 0,
        engagementDisabled: true,
        skipAgent: true,
        feeds: [{
          target: { kind: "for_you" },
          rejected: true,
          rejectReason: "repeated_two_hash_stale",
        }],
      },
    })

    const health = await buildHealthSnapshot({
      agentRoot,
      archiveRoot,
      nowIso: NOW,
      layout,
    })

    expect(health.schema).toBe(1)
    expect(health.lock.held).toBe(true)
    expect(health.lock.stale).toBe(true)
    expect(health.research.ambiguous).toBe(1)
    expect(health.research.actionable).toBe(0)
    expect(health.wallets.silent).toBe(true)
    expect(health.x.pendingActions).toBe(1)
    expect(health.x.blocked).toBe(true)
    expect(health.farcaster.staleStreak).toBe(2)
    expect(health.farcaster.lastFallbackUsed).toBe(true)
    expect(health.skipReasons["research"]?.["queue-empty"]).toBe(3)

    const listJob = health.jobs.find((j) => j.job === "list-scan")
    expect(listJob?.lastSuccess?.runId).toBe("list-scan-2026-07-18T10-00-00-000Z")
    const researchJob = health.jobs.find((j) => j.job === "research")
    expect(researchJob?.lastSkip?.reason).toBe("queue-empty")

    expect(healthCreatesReviewScope(health)).toBe(true)
    expect(health.warnings.some((w) => /stale workspace lock/u.test(w))).toBe(true)
    expect(health.warnings.some((w) => /fc stale streak/u.test(w))).toBe(true)
    expect(health.warnings.some((w) => /recurring skip/u.test(w))).toBe(true)

    expect(health.fomo.parallelOnly).toBe(true)
    expect(typeof health.fomo.enabled).toBe("boolean")
    expect(typeof health.fomo.shadowMode).toBe("boolean")
    // FOMO is parallel-only: empty research/wallets still warn regardless of fomo
    expect(health.warnings.some((w) => /research queue empty/u.test(w))).toBe(true)
    expect(health.warnings.some((w) => /wallets silent/u.test(w))).toBe(true)

    const text = formatHealthText(health)
    expect(text).toContain("trenchcoat health")
    expect(text).toContain("research: actionable=0")
    expect(text).toMatch(/^fomo: enabled=\S+ shadow=\S+ \(parallel-only\)$/mu)
    expect(text).not.toMatch(/TELEGRAM_|HMAC|token=/iu)

    const json = toHealthJsonPayload(health)
    expect(json["schema"]).toBe(1)
    expect(Array.isArray(json["warnings"])).toBe(true)
    expect(json["fomo"]).toMatchObject({ parallelOnly: true })

    const lines = healthSnapshotLines(health)
    expect(lines.some((l) => l.startsWith("fcStaleStreak="))).toBe(true)
    expect(lines.some((l) => l.startsWith("fomoEnabled="))).toBe(true)
    expect(skipLedgerLines(health.skipReasons)[0]).toContain("queue-empty")
  })

  it("reports abandoned incomplete runs without inventing secrets", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-health-abandon-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    const layout = await ensureArchive(archiveRoot)
    const state = new StateStore(join(agentRoot, "state"))
    await state.saveWatchlist({ schema: 1, entries: [] })

    const store = createJournalStore(layout)
    const runId = "list-scan-2026-07-18T01-00-00-000Z"
    await store.save({
      schema: 1,
      runId,
      phase: "created",
      status: "running",
      phaseHashes: {},
      sideEffects: {},
    })

    const health = await buildHealthSnapshot({
      agentRoot,
      archiveRoot,
      nowIso: NOW,
      layout,
    })
    expect(health.incompleteRuns.some((r) => (
      r.runId === runId && r.status === "abandoned"
    ))).toBe(true)
    expect(JSON.stringify(toHealthJsonPayload(health))).not.toMatch(/sk-|secret|api[_-]?key/iu)
  })
})

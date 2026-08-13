import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { collectFomoXSourceReview } from "../../src/orchestrator/fomo-x-source-review.js"
import { mergeFomoXClassification } from "../../src/orchestrator/fomo-x-classification-merge.js"
import { StateStore } from "../../src/lib/state.js"
import { emptyXSourceNominations, upsertXSourceNominations } from "../../src/sources/x-nominations.js"
import type { FomoLeaderboardEntry } from "../../src/collectors/fomo/types.js"
import { loadConfig } from "../../src/lib/config.js"
import bs58 from "bs58"

function solMint(n: number): string {
  const buf = Buffer.alloc(32, 1)
  buf[0] = n + 2
  buf[31] = n + 3
  return bs58.encode(buf)
}

function enableXReview(agentRoot: string): void {
  const config = loadConfig()
  // Tests rely on process config; force nominations via StateStore only and
  // skip when fomo.x_source_review.enabled is false in seed.
  void agentRoot
  void config
}

function historyPosts(count: number, startDay = 1) {
  return Array.from({ length: count }, (_, i) => {
    const day = String(startDay + (i % 5)).padStart(2, "0")
    return {
      id: `p${i + 1}`,
      author: "alpha",
      text: `buy call post ${i}`,
      url: `https://x.com/alpha/status/${i + 1}`,
      timestamp: `2026-07-${day}T12:00:00.000Z`,
      provenance: "twitter:@alpha",
    }
  })
}

describe("fomo x classification merge", () => {
  it("fail-closes on unsealed evidence ids and restores pending", async () => {
    enableXReview("")
    const root = mkdtempSync(join(tmpdir(), "fomo-x-cls-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "inbox", "run-1"), { recursive: true })
    mkdirSync(join(agentRoot, "reports", "run-1"), { recursive: true })
    mkdirSync(join(agentRoot, "state"), { recursive: true })

    const state = new StateStore(join(agentRoot, "state"))
    const traders: FomoLeaderboardEntry[] = [{
      handle: "alpha",
      timeframe: "7d",
      rank: 1,
      wallets: [],
      observedAt: "2026-07-19T00:00:00.000Z",
    }]
    let nominations = upsertXSourceNominations(emptyXSourceNominations(), {
      traders,
      nominatedAt: "2026-07-19T00:00:00.000Z",
      maxPending: 10,
    })
    const id = nominations.nominations[0]!.nominationId
    nominations = {
      schema: 1,
      nominations: nominations.nominations.map((n) => (
        n.nominationId === id ? { ...n, status: "classifying" as const, attempts: 1 } : n
      )),
    }
    await state.saveXSourceNominations(nominations)

    writeFileSync(join(agentRoot, "inbox", "run-1", "x-source-manifest.json"), JSON.stringify({
      schema: 1,
      source: "host.fomo-x-source-review",
      fetchedAt: "2026-07-19T00:00:00.000Z",
      trust: "untrusted-external",
      items: [{
        provenance: "run-1:manifest",
        text: `nominationId=${id} xHandle=alpha fomoHandle=alpha matchBasis=same-handle sealedPostIds=p1,p2,p3 postCount=3 activeDays=3`,
        ts: "2026-07-19T00:00:00.000Z",
        ageSec: 0,
        freshnessTier: "live",
      }],
    }))

    writeFileSync(join(agentRoot, "reports", "run-1", "fomo-x-classification.json"), JSON.stringify({
      schema: 1,
      nominationId: id,
      xHandle: "alpha",
      classification: "shiller",
      confidence: 0.9,
      shillPostIds: ["p1", "p2", "p3", "p4", "p5", "evil-unsealed"],
      narrativePostIds: [],
      noisePostIds: [],
      reasonCodes: ["shill-dense"],
    }))

    const report = await mergeFomoXClassification({
      agentRoot,
      archiveRoot,
      runId: "run-1",
      nowIso: "2026-07-19T01:00:00.000Z",
    })
    expect(report.ok).toBe(false)
    expect(report.reason).toBe("unsealed-post-ids")
    const after = state.loadXSourceNominations()
    expect(after.nominations[0]?.status).toBe("pending")
  })

  it("writes historical history snapshot with purpose tag via collect", async () => {
    const root = mkdtempSync(join(tmpdir(), "fomo-x-hist-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "inbox"), { recursive: true })
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    const state = new StateStore(join(agentRoot, "state"))
    await state.saveXSourceNominations(upsertXSourceNominations(emptyXSourceNominations(), {
      traders: [{
        handle: "alpha",
        timeframe: "7d",
        rank: 1,
        wallets: [],
        observedAt: "2026-07-19T00:00:00.000Z",
      }],
      nominatedAt: "2026-07-19T00:00:00.000Z",
      maxPending: 10,
    }))

    const writer = new SnapshotWriter(agentRoot)
    const summary = await collectFomoXSourceReview({
      runId: "fomo-x-source-review-test",
      writer,
      fetchedAt: "2026-07-19T12:00:00.000Z",
      agentRoot,
      archiveRoot,
      posts: historyPosts(25),
    })

    if (summary.collectionStatus === "fomo-disabled") {
      expect(summary.skipAgent).toBe(true)
      return
    }

    expect(summary.collectionStatus).toBe("fomo-x-ready")
    const history = JSON.parse(
      readFileSync(join(agentRoot, "inbox", "fomo-x-source-review-test", "x-source-history.json"), "utf8"),
    ) as { items: Array<{ text: string }> }
    expect(history.items.every((item) => item.text.startsWith("purpose=historical-source-evaluation"))).toBe(true)
    const profile = JSON.parse(
      readFileSync(join(agentRoot, "inbox", "fomo-x-source-review-test", "fomo-profile-calls.json"), "utf8"),
    ) as { items: Array<{ text: string }> }
    expect(profile.items[0]?.text).toContain("kind=fomo-profile-calls")
  })

  it("unions sealed FOMO profile buys into shiller call history", async () => {
    const seeded = await seedShillerMerge({
      includeProfileCalls: true,
    })
    const report = await mergeFomoXClassification({
      agentRoot: seeded.agentRoot,
      archiveRoot: seeded.archiveRoot,
      runId: "run-1",
      nowIso: "2026-07-19T13:00:00.000Z",
    })
    expect(report.ok).toBe(true)
    expect(report.reason).toBe("classified")
    expect(report.callCount).toBe(10)
    expect(report.distinctTokens).toBe(10)
    expect(report.status).toBe("classified")
    const lifecycle = seeded.state.loadSourceLifecycle()
    expect(lifecycle.candidates.some((c) => c.handle === "alpha")).toBe(true)
  })

  it("keeps insufficient-call-history when FOMO profile swaps are empty", async () => {
    const seeded = await seedShillerMerge({
      includeProfileCalls: false,
    })
    const report = await mergeFomoXClassification({
      agentRoot: seeded.agentRoot,
      archiveRoot: seeded.archiveRoot,
      runId: "run-1",
      nowIso: "2026-07-19T13:00:00.000Z",
    })
    expect(report.ok).toBe(true)
    expect(report.reason).toBe("insufficient-call-history")
    expect(report.callCount).toBe(0)
    expect(report.status).toBe("insufficient-history")
  })
})

async function seedShillerMerge(args: Readonly<{ includeProfileCalls: boolean }>) {
  const root = mkdtempSync(join(tmpdir(), "fomo-x-merge-"))
  const agentRoot = join(root, "agent")
  const archiveRoot = join(root, "archive")
  mkdirSync(join(agentRoot, "inbox", "run-1"), { recursive: true })
  mkdirSync(join(agentRoot, "reports", "run-1"), { recursive: true })
  mkdirSync(join(agentRoot, "state"), { recursive: true })
  const state = new StateStore(join(agentRoot, "state"))
  let nominations = upsertXSourceNominations(emptyXSourceNominations(), {
    traders: [{
      handle: "alpha",
      timeframe: "7d",
      rank: 1,
      wallets: [],
      observedAt: "2026-07-19T00:00:00.000Z",
    }],
    nominatedAt: "2026-07-19T00:00:00.000Z",
    maxPending: 10,
  })
  const id = nominations.nominations[0]!.nominationId
  nominations = {
    schema: 1,
    nominations: nominations.nominations.map((n) => (
      n.nominationId === id ? { ...n, status: "classifying" as const, attempts: 1 } : n
    )),
  }
  await state.saveXSourceNominations(nominations)

  const sealedIds = Array.from({ length: 25 }, (_, i) => `p${i + 1}`)
  writeFileSync(join(agentRoot, "inbox", "run-1", "x-source-manifest.json"), JSON.stringify({
    schema: 1,
    source: "host.fomo-x-source-review",
    fetchedAt: "2026-07-19T00:00:00.000Z",
    trust: "untrusted-external",
    items: [{
      provenance: "run-1:manifest",
      text: `nominationId=${id} xHandle=alpha fomoHandle=alpha matchBasis=same-handle sealedPostIds=${sealedIds.join(",")} postCount=25 activeDays=5`,
      ts: "2026-07-19T00:00:00.000Z",
      ageSec: 0,
      freshnessTier: "live",
    }],
  }))
  writeFileSync(join(agentRoot, "inbox", "run-1", "x-source-history.json"), JSON.stringify({
    schema: 1,
    source: "host.fomo-x-source-review.historical",
    fetchedAt: "2026-07-19T00:00:00.000Z",
    trust: "untrusted-external",
    items: sealedIds.map((postId, i) => ({
      provenance: "twitter:@alpha",
      text: `purpose=historical-source-evaluation postId=${postId} author=alpha $CASHCAT ticker shill ${i}`,
      ts: `2026-07-${String(1 + (i % 5)).padStart(2, "0")}T12:00:00.000Z`,
      ageSec: 0,
      freshnessTier: "live",
    })),
  }))
  const profileItems = args.includeProfileCalls
    ? Array.from({ length: 10 }, (_, i) => ({
      provenance: "fomo-profile:@alpha",
      text: `purpose=fomo-profile-call handle=alpha action=buy chain=solana buy ${solMint(i)}`,
      ts: `2026-07-${String(1 + (i % 10)).padStart(2, "0")}T08:00:00.000Z`,
      ageSec: 0,
      freshnessTier: "live",
    }))
    : []
  writeFileSync(join(agentRoot, "inbox", "run-1", "fomo-profile-calls.json"), JSON.stringify({
    schema: 1,
    source: "host.fomo-x-source-review.profile-calls",
    fetchedAt: "2026-07-19T00:00:00.000Z",
    trust: "untrusted-external",
    items: [
      {
        provenance: "run-1:fomo-profile:alpha",
        text: `kind=fomo-profile-calls handle=alpha buyCount=${profileItems.length}`,
        ts: "2026-07-19T00:00:00.000Z",
        ageSec: 0,
        freshnessTier: "live",
      },
      ...profileItems,
    ],
  }))
  writeFileSync(join(agentRoot, "reports", "run-1", "fomo-x-classification.json"), JSON.stringify({
    schema: 1,
    nominationId: id,
    xHandle: "alpha",
    classification: "shiller",
    confidence: 0.9,
    shillPostIds: ["p1", "p2", "p3", "p4", "p5"],
    narrativePostIds: [],
    noisePostIds: [],
    reasonCodes: ["shill-dense"],
  }))
  return { agentRoot, archiveRoot, state }
}

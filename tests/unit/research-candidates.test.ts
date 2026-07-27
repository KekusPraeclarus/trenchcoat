import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ConfigSchema } from "../../src/lib/config.js"
import { migrateConfigToV22 } from "../../src/migrations/config.js"
import { ensureArchive, runArchiveDir } from "../../src/lib/archive.js"
import { StateStore } from "../../src/lib/state.js"
import { validateAndEnqueueResearchCandidates, detectSocialResearchCandidates } from "../../src/orchestrator/research-candidates.js"
import {
  migrateGenericNarrativeResearchQueue,
  repairGenericNarrativeQueueEntries,
} from "../../src/migrations/research-queue.js"
import type { ResearchQueueEntry } from "../../src/contracts/schemas.js"

const NOW = "2026-07-19T12:00:00.000Z"
const TOKEN = "So11111111111111111111111111111111111111112"
const TOKEN2 = "So11111111111111111111111111111111111111113"
const RUN = "list-scan-rc-1"

function writeMinimalConfig(dir: string): void {
  const cfg = ConfigSchema.parse(migrateConfigToV22({
    schema: 5,
    twitter: {
      operator_list_urls: [
        "https://x.com/i/lists/1",
        "https://x.com/i/lists/2",
      ],
      managed_list: {
        name: "trenchcoat-sources",
        description: "Sources promoted by trenchcoat",
        capacity: 250,
      },
      source_lifecycle: { promotion: {}, demotion: {} },
      engagement: {},
    },
    research: { daily_cap: 3 },
    broadcast: {},
    indicators: {},
    gate_thresholds: {},
    audit: { rsi_promotion: {} },
    wallets: { deterministic_weight: 0.8, llm_weight: 0.2, promotion: {}, drop: {} },
    source_safety: {},
    retention: {},
    chat: {},
    router: {},
    harness_improvement: {},
  }))
  mkdirSync(join(dir, ".trenchcoat"), { recursive: true })
  writeFileSync(join(dir, ".trenchcoat", "config.json"), `${JSON.stringify(cfg, null, 2)}\n`)
}

async function scaffold(): Promise<{
  home: string
  agentRoot: string
  archiveRoot: string
  layout: Awaited<ReturnType<typeof ensureArchive>>
  restoreHome: () => void
}> {
  const root = mkdtempSync(join(tmpdir(), "tc-research-cand-"))
  const home = join(root, "home")
  const agentRoot = join(root, "agent")
  const archiveRoot = join(root, "archive")
  mkdirSync(join(agentRoot, "state"), { recursive: true })
  mkdirSync(join(agentRoot, "reports", RUN), { recursive: true })
  writeFileSync(join(agentRoot, "state", "watchlist.json"), `${JSON.stringify({ schema: 1, entries: [] }, null, 2)}\n`)
  writeFileSync(join(agentRoot, "state", "research-queue.json"), `${JSON.stringify({ schema: 1, entries: [] }, null, 2)}\n`)
  writeFileSync(join(agentRoot, "state", "ledger.json"), `${JSON.stringify({ schema: 1, positions: [] }, null, 2)}\n`)
  writeFileSync(join(agentRoot, "state", "wallets.json"), `${JSON.stringify({ schema: 1, wallets: [] }, null, 2)}\n`)
  writeFileSync(join(agentRoot, "state", "decisions.md"), "")
  writeMinimalConfig(home)
  const prevHome = process.env["HOME"]
  process.env["HOME"] = home
  const layout = await ensureArchive(archiveRoot)
  return {
    home,
    agentRoot,
    archiveRoot,
    layout,
    restoreHome: () => {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
    },
  }
}


function writeSealedInbox(
  layout: Awaited<ReturnType<typeof ensureArchive>>,
  items: readonly { provenance: string; text: string; freshnessTier?: "live" | "stale" | "expired" }[],
): void {
  const inboxDir = join(runArchiveDir(layout, RUN), "inbox")
  mkdirSync(inboxDir, { recursive: true })
  writeFileSync(join(inboxDir, "twitter-fyp.json"), `${JSON.stringify({
    source: "host.twitter",
    fetchedAt: NOW,
    trust: "untrusted-external",
    items: items.map((item) => ({
      provenance: item.provenance,
      text: item.text,
      ts: NOW,
      ageSec: 60,
      freshnessTier: item.freshnessTier ?? "live",
    })),
  }, null, 2)}\n`)
  writeFileSync(join(runArchiveDir(layout, RUN), "manifest.json"), `${JSON.stringify({
    schema: 1,
    runId: RUN,
    job: "list-scan",
    createdAt: NOW,
    inboxManifest: { "twitter-fyp.json": "sha256:abc" },
  }, null, 2)}\n`)
}

function writeProposal(agentRoot: string, candidates: unknown[]): void {
  writeFileSync(join(agentRoot, "reports", RUN, "research-candidates.json"), `${JSON.stringify({
    schema: 1,
    runId: RUN,
    proposedAt: NOW,
    candidates,
  }, null, 2)}\n`)
}

describe("research candidates", () => {
  it("detects multi-author CA clusters as host hints (top 3)", async () => {
    const { agentRoot, layout, restoreHome } = await scaffold()
    try {
      const TOKEN3 = "So11111111111111111111111111111111111111114"
      const TOKEN4 = "So11111111111111111111111111111111111111115"
      writeSealedInbox(layout, [
        { provenance: "twitter:@alice:1", text: `buying solana:${TOKEN}` },
        { provenance: "twitter:@bob:2", text: `also watching ${TOKEN}` },
        { provenance: "twitter:@carol:3", text: `solana:${TOKEN2} looks live` },
        { provenance: "twitter:@dave:4", text: `watching ${TOKEN2}` },
        { provenance: "twitter:@erin:5", text: `solana:${TOKEN3}` },
        { provenance: "twitter:@frank:6", text: `${TOKEN3} too` },
        { provenance: "twitter:@gina:7", text: `solo only ${TOKEN4}` },
      ])

      const hints = detectSocialResearchCandidates({
        layout,
        runId: RUN,
        agentRoot,
      })
      expect(hints).toHaveLength(3)
      expect(hints.every((h) => h.authorCount >= 2)).toBe(true)
      expect(hints.every((h) => h.evidenceRefs.every((ref) => ref.startsWith(`inbox/${RUN}/`)))).toBe(true)
      expect(hints.some((h) => h.tokenAddress === TOKEN4)).toBe(false)
    } finally {
      restoreHome()
    }
  })

  it("enqueues when sealed evidence has the CA from two independent authors", async () => {
    const { agentRoot, layout, restoreHome } = await scaffold()
    try {
    writeSealedInbox(layout, [
      { provenance: "twitter:@alice:1", text: `buying solana:${TOKEN}` },
      { provenance: "twitter:@bob:2", text: `also watching ${TOKEN}` },
    ])
    writeProposal(agentRoot, [{
      schema: 1,
      candidateId: "rc-1",
      chain: "solana",
      tokenAddress: TOKEN,
      evidenceRefs: [`inbox/${RUN}/twitter-fyp.json`],
      authors: ["twitter:@alice", "twitter:@bob"],
      reason: "two authors",
    }])

    const receipt = await validateAndEnqueueResearchCandidates({
      agentRoot,
      layout,
      runId: RUN,
      nowIso: NOW,
    })

    expect(receipt.accepted).toHaveLength(1)
    expect(receipt.rejected).toHaveLength(0)
    const queue = new StateStore(join(agentRoot, "state")).loadResearchQueue()
    expect(queue.entries).toHaveLength(1)
    expect(queue.entries[0]).toMatchObject({
      trigger: "social",
      chain: "solana",
      tokenAddress: TOKEN,
      status: "pending",
      clusterCount: 2,
    })
    expect(readFileSync(join(agentRoot, "state", "watchlist.json"), "utf8")).toContain('"entries": []')
    expect(readFileSync(join(agentRoot, "state", "ledger.json"), "utf8")).toContain('"positions": []')
    expect(readFileSync(join(agentRoot, "state", "wallets.json"), "utf8")).toContain('"wallets": []')
    expect(readFileSync(join(agentRoot, "state", "decisions.md"), "utf8")).toBe("")
    } finally {
      restoreHome()
    }
  })

  it("rejects invented addresses, single-author, expired, and over-cap nominations", async () => {
    const { agentRoot, layout, restoreHome } = await scaffold()
    try {
    writeSealedInbox(layout, [
      { provenance: "twitter:@alice:1", text: `buying ${TOKEN}`, freshnessTier: "live" },
      { provenance: "twitter:@bob:2", text: `also ${TOKEN}`, freshnessTier: "live" },
      { provenance: "twitter:@carol:3", text: `old ${TOKEN2}`, freshnessTier: "expired" },
    ])
    writeProposal(agentRoot, [
      {
        schema: 1,
        candidateId: "rc-invented",
        chain: "solana",
        tokenAddress: "So11111111111111111111111111111111111111199",
        evidenceRefs: [`inbox/${RUN}/twitter-fyp.json`],
        reason: "invented",
      },
      {
        schema: 1,
        candidateId: "rc-one-author",
        chain: "solana",
        tokenAddress: TOKEN,
        evidenceRefs: [`inbox/${RUN}/twitter-fyp.json`],
        reason: "will accept first",
      },
      {
        schema: 1,
        candidateId: "rc-expired",
        chain: "solana",
        tokenAddress: TOKEN2,
        evidenceRefs: [`inbox/${RUN}/twitter-fyp.json`],
        reason: "expired only",
      },
      {
        schema: 1,
        candidateId: "rc-2",
        chain: "solana",
        tokenAddress: TOKEN,
        evidenceRefs: [`inbox/${RUN}/twitter-fyp.json`],
        reason: "duplicate of first accept",
      },
      {
        schema: 1,
        candidateId: "rc-3",
        chain: "solana",
        tokenAddress: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        evidenceRefs: [`inbox/${RUN}/twitter-fyp.json`],
        reason: "not in evidence",
      },
      {
        schema: 1,
        candidateId: "rc-4",
        chain: "solana",
        tokenAddress: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        evidenceRefs: [`inbox/${RUN}/twitter-fyp.json`],
        reason: "not in evidence either",
      },
    ])

    const receipt = await validateAndEnqueueResearchCandidates({
      agentRoot,
      layout,
      runId: RUN,
      nowIso: NOW,
    })

    expect(receipt.accepted.map((a) => a.candidateId)).toEqual(["rc-one-author"])
    expect(receipt.rejected.some((r) => r.candidateId === "rc-invented" && r.reason === "address-not-in-evidence")).toBe(true)
    expect(receipt.rejected.some((r) => r.candidateId === "rc-expired" && r.reason === "evidence-expired")).toBe(true)
    expect(receipt.rejected.some((r) => r.candidateId === "rc-2" && r.reason === "duplicated-queue")).toBe(true)
    } finally {
      restoreHome()
    }
  })

  it("caps accepted nominations at three per run", async () => {
    const { agentRoot, layout, restoreHome } = await scaffold()
    try {
    const tokens = [
      "So11111111111111111111111111111111111111112",
      "So11111111111111111111111111111111111111113",
      "So11111111111111111111111111111111111111114",
      "So11111111111111111111111111111111111111115",
    ]
    writeSealedInbox(layout, tokens.flatMap((token, index) => ([
      { provenance: `twitter:@a${index}:1`, text: `buy ${token}` },
      { provenance: `twitter:@b${index}:2`, text: `also ${token}` },
    ])))
    writeProposal(agentRoot, tokens.map((token, index) => ({
      schema: 1,
      candidateId: `rc-${index}`,
      chain: "solana",
      tokenAddress: token,
      evidenceRefs: [`inbox/${RUN}/twitter-fyp.json`],
      reason: `cap-${index}`,
    })))

    const receipt = await validateAndEnqueueResearchCandidates({
      agentRoot,
      layout,
      runId: RUN,
      nowIso: NOW,
    })

    expect(receipt.accepted).toHaveLength(3)
    expect(receipt.rejected.some((r) => r.reason === "over-cap")).toBe(true)
    expect(new StateStore(join(agentRoot, "state")).loadResearchQueue().entries).toHaveLength(3)
    } finally {
      restoreHome()
    }
  })
})

describe("generic narrative queue repair", () => {
  it("rejects only auto-generated ambiguous narrative generics and archives a receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-rq-repair-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    const ambiguousSol: ResearchQueueEntry = {
      schema: 1,
      queueId: "rq-narrative-sol-season-sol",
      subject: "SOL",
      priority: 55,
      firstSeen: NOW,
      enqueuedAt: NOW,
      enqueuedBy: "narrative:sol-season",
      trigger: "narrative",
      expiresAt: "2026-08-01T12:00:00.000Z",
      provenance: ["narrative:sol-season"],
      clusterCount: 1,
      security: { status: "pending", flags: [] },
      status: "ambiguous",
      resolution: "ambiguous",
      reason: "narrative ticker ambiguous; shortlist=solana:abc",
    }
    const keep: ResearchQueueEntry = {
      ...ambiguousSol,
      queueId: "rq-narrative-jimothy-jimothy",
      subject: "JIMOTHY",
      enqueuedBy: "narrative:jimothy",
      provenance: ["narrative:jimothy"],
    }
    const operator: ResearchQueueEntry = {
      ...ambiguousSol,
      queueId: "rq-operator-sol",
      enqueuedBy: "operator:telegram",
      trigger: "operator",
      subject: "SOL",
    }
    writeFileSync(join(agentRoot, "state", "research-queue.json"), `${JSON.stringify({
      schema: 1,
      entries: [ambiguousSol, keep, operator],
    }, null, 2)}\n`)

    const { repaired } = repairGenericNarrativeQueueEntries({
      schema: 1,
      entries: [ambiguousSol, keep, operator],
    }, NOW)
    expect(repaired).toHaveLength(1)
    expect(repaired[0]?.queueId).toBe("rq-narrative-sol-season-sol")

    const report = await migrateGenericNarrativeResearchQueue({
      agentRoot,
      archiveRoot,
      nowIso: NOW,
    })
    expect(report.repairedCount).toBe(1)
    expect(report.skipped).toBe(false)

    const queue = new StateStore(join(agentRoot, "state")).loadResearchQueue()
    expect(queue.entries.find((e) => e.queueId === ambiguousSol.queueId)).toMatchObject({
      status: "rejected",
      reason: "generic-chain-symbol",
    })
    expect(queue.entries.find((e) => e.queueId === keep.queueId)?.status).toBe("ambiguous")
    expect(queue.entries.find((e) => e.queueId === operator.queueId)?.status).toBe("ambiguous")

    const again = await migrateGenericNarrativeResearchQueue({
      agentRoot,
      archiveRoot,
      nowIso: NOW,
    })
    expect(again.skipped).toBe(true)
    expect(again.reason).toBe("receipt-present")
  })
})

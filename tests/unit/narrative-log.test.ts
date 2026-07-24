import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive } from "../../src/lib/archive.js"
import {
  effectiveFraming,
  mergeNarrativeProposals,
  pruneNarrativeLog,
  pruneNarrativeLogInMemory,
} from "../../src/orchestrator/narrative-log.js"

const NOW = "2026-07-17T12:00:00.000Z"
const RUN_ID = "20260717T120000Z-ab12cd34"

function entry(overrides: Record<string, unknown> = {}) {
  return {
    slug: "base-ai",
    title: "Base AI",
    firstSeen: "2026-07-10T12:00:00.000Z",
    lastSeen: "2026-07-16T12:00:00.000Z",
    evidence: ["twitter:@alice:1"],
    stage: "emerging",
    ...overrides,
  }
}

describe("pruneNarrativeLogInMemory", () => {
  it("keeps entries within retention and purges older ones", () => {
    const fresh = entry({ slug: "fresh", lastSeen: "2026-07-16T12:00:00.000Z" })
    // 15 days before NOW — just outside 14-day retention
    const stale = entry({
      slug: "stale",
      firstSeen: "2026-06-01T12:00:00.000Z",
      lastSeen: "2026-07-02T12:00:00.000Z",
    })
    const raw = `${JSON.stringify(fresh)}\n${JSON.stringify(stale)}\n`
    const result = pruneNarrativeLogInMemory(raw, NOW, 14)
    expect(result.kept).toBe(1)
    expect(result.purged).toBe(1)
    expect(result.malformed).toBe(0)
    expect(result.entries.map((e) => e.slug)).toEqual(["fresh"])
  })

  it("keeps an entry exactly at the retention boundary", () => {
    const boundary = entry({
      slug: "edge",
      firstSeen: "2026-07-01T12:00:00.000Z",
      lastSeen: "2026-07-03T12:00:00.000Z",
    })
    const result = pruneNarrativeLogInMemory(`${JSON.stringify(boundary)}\n`, NOW, 14)
    expect(result.kept).toBe(1)
    expect(result.purged).toBe(0)
  })

  it("drops malformed lines without aborting", () => {
    const good = entry()
    const raw = [
      "not-json",
      JSON.stringify({ slug: "bad" }),
      JSON.stringify(good),
      "",
      '{"slug":"also-bad","title":1}',
    ].join("\n")
    const result = pruneNarrativeLogInMemory(raw, NOW, 14)
    expect(result.kept).toBe(1)
    expect(result.malformed).toBe(3)
    expect(result.entries[0]?.slug).toBe("base-ai")
  })

  it("collapses duplicate slugs keeping earliest firstSeen and latest lastSeen", () => {
    const older = entry({
      firstSeen: "2026-07-01T00:00:00.000Z",
      lastSeen: "2026-07-10T00:00:00.000Z",
      stage: "emerging",
      title: "old title",
    })
    const newer = entry({
      firstSeen: "2026-07-05T00:00:00.000Z",
      lastSeen: "2026-07-16T00:00:00.000Z",
      stage: "peaking",
      title: "new title",
      evidence: ["twitter:@bob:2"],
    })
    const raw = `${JSON.stringify(older)}\n${JSON.stringify(newer)}\n`
    const result = pruneNarrativeLogInMemory(raw, NOW, 14)
    expect(result.kept).toBe(1)
    expect(result.entries[0]).toMatchObject({
      slug: "base-ai",
      firstSeen: "2026-07-01T00:00:00.000Z",
      lastSeen: "2026-07-16T00:00:00.000Z",
      stage: "peaking",
      title: "new title",
    })
  })

  it("treats empty input as an empty log", () => {
    const result = pruneNarrativeLogInMemory("", NOW, 14)
    expect(result).toEqual({ entries: [], kept: 0, purged: 0, malformed: 0 })
  })

  it("is idempotent for a already-pruned log", () => {
    const good = entry()
    const first = pruneNarrativeLogInMemory(`${JSON.stringify(good)}\n`, NOW, 14)
    const second = pruneNarrativeLogInMemory(
      first.entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
      NOW,
      14,
    )
    expect(second.entries).toEqual(first.entries)
    expect(second.purged).toBe(0)
    expect(second.malformed).toBe(0)
  })
})

describe("pruneNarrativeLog", () => {
  it("rewrites the log atomically and archives a receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-narrative-"))
    const agentRoot = join(root, "agent")
    const layout = await ensureArchive(join(root, "archive"))
    mkdirSync(join(agentRoot, "state", "narratives"), { recursive: true })
    const path = join(agentRoot, "state", "narratives", "log.jsonl")
    writeFileSync(
      path,
      [
        JSON.stringify(entry()),
        "garbage",
        JSON.stringify(entry({
          slug: "old-one",
          firstSeen: "2026-06-01T00:00:00.000Z",
          lastSeen: "2026-07-01T00:00:00.000Z",
        })),
      ].join("\n") + "\n",
    )

    const report = await pruneNarrativeLog({
      agentRoot,
      layout,
      runId: RUN_ID,
      nowIso: NOW,
      retentionDays: 14,
    })

    expect(report.kept).toBe(1)
    expect(report.purged).toBe(1)
    expect(report.malformed).toBe(1)
    const rewritten = readFileSync(path, "utf8").trim().split("\n")
    expect(rewritten).toHaveLength(1)
    expect(JSON.parse(rewritten[0]!).slug).toBe("base-ai")
    expect(existsSync(join(layout.runs, RUN_ID, "narrative-log-prune.json"))).toBe(true)
  })

  it("creates an empty log when the file is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-narrative-missing-"))
    const agentRoot = join(root, "agent")
    const report = await pruneNarrativeLog({
      agentRoot,
      runId: RUN_ID,
      nowIso: NOW,
      retentionDays: 14,
    })
    expect(report.kept).toBe(0)
    expect(readFileSync(join(agentRoot, "state", "narratives", "log.jsonl"), "utf8")).toBe("")
  })
})

describe("narrative framing", () => {
  it("treats omitted framing as rotation", () => {
    const result = pruneNarrativeLogInMemory(`${JSON.stringify(entry())}\n`, NOW, 14)
    expect(result.entries[0]).toMatchObject({ slug: "base-ai" })
    expect(result.entries[0]?.framing).toBeUndefined()
    expect(effectiveFraming(result.entries[0]!)).toBe("rotation")
  })

  it("drops mature proposals missing framingEvidence", () => {
    const bad = entry({
      framing: "ecosystem",
      framingMaturedAt: "2026-07-16T12:00:00.000Z",
    })
    const result = pruneNarrativeLogInMemory(`${JSON.stringify(bad)}\n`, NOW, 14)
    expect(result.kept).toBe(0)
    expect(result.malformed).toBe(1)
  })

  it("drops mature proposals whose title still says rotation", () => {
    const bad = entry({
      title: "RH chain meme rotation",
      framing: "ecosystem",
      framingMaturedAt: "2026-07-16T12:00:00.000Z",
      framingEvidence: ["twitter:@bob:2"],
    })
    const result = pruneNarrativeLogInMemory(`${JSON.stringify(bad)}\n`, NOW, 14)
    expect(result.kept).toBe(0)
    expect(result.malformed).toBe(1)
  })

  it("accepts a valid ecosystem maturity line", () => {
    const mature = entry({
      title: "RH Chain agent infra",
      framing: "ecosystem",
      framingMaturedAt: "2026-07-16T12:00:00.000Z",
      framingEvidence: ["twitter:@bob:2"],
    })
    const result = pruneNarrativeLogInMemory(`${JSON.stringify(mature)}\n`, NOW, 14)
    expect(result.kept).toBe(1)
    expect(result.entries[0]).toMatchObject({
      framing: "ecosystem",
      framingMaturedAt: "2026-07-16T12:00:00.000Z",
      title: "RH Chain agent infra",
    })
  })

  it("never regresses mature framing when a later line omits or sets rotation", () => {
    const mature = entry({
      title: "RH Chain agent infra",
      lastSeen: "2026-07-15T12:00:00.000Z",
      framing: "ecosystem",
      framingMaturedAt: "2026-07-15T12:00:00.000Z",
      framingEvidence: ["twitter:@bob:2"],
    })
    const later = entry({
      title: "RH Chain agent infra update",
      lastSeen: "2026-07-16T12:00:00.000Z",
      framing: "rotation",
      evidence: ["twitter:@carol:3"],
    })
    const result = pruneNarrativeLogInMemory(
      `${JSON.stringify(mature)}\n${JSON.stringify(later)}\n`,
      NOW,
      14,
    )
    expect(result.entries[0]).toMatchObject({
      framing: "ecosystem",
      framingMaturedAt: "2026-07-15T12:00:00.000Z",
      lastSeen: "2026-07-16T12:00:00.000Z",
      title: "RH Chain agent infra update",
    })
  })

  it("promotes rotation to ecosystem on a later valid maturity line", () => {
    const prior = entry({
      title: "RH chain meme rotation",
      lastSeen: "2026-07-14T12:00:00.000Z",
    })
    const mature = entry({
      title: "RH Chain agent infra",
      lastSeen: "2026-07-16T12:00:00.000Z",
      framing: "ecosystem",
      framingMaturedAt: "2026-07-16T12:00:00.000Z",
      framingEvidence: ["twitter:@bob:2"],
    })
    const result = pruneNarrativeLogInMemory(
      `${JSON.stringify(prior)}\n${JSON.stringify(mature)}\n`,
      NOW,
      14,
    )
    expect(result.entries[0]).toMatchObject({
      framing: "ecosystem",
      firstSeen: "2026-07-10T12:00:00.000Z",
      framingMaturedAt: "2026-07-16T12:00:00.000Z",
    })
  })

  it("keeps the earlier maturity when ecosystem and regime disagree", () => {
    const ecosystem = entry({
      title: "RH Chain agent infra",
      lastSeen: "2026-07-15T12:00:00.000Z",
      framing: "ecosystem",
      framingMaturedAt: "2026-07-15T12:00:00.000Z",
      framingEvidence: ["twitter:@bob:2"],
    })
    const regime = entry({
      title: "RH Chain regime",
      lastSeen: "2026-07-16T12:00:00.000Z",
      framing: "regime",
      framingMaturedAt: "2026-07-16T12:00:00.000Z",
      framingEvidence: ["twitter:@carol:3"],
    })
    const result = pruneNarrativeLogInMemory(
      `${JSON.stringify(ecosystem)}\n${JSON.stringify(regime)}\n`,
      NOW,
      14,
    )
    expect(result.entries[0]).toMatchObject({
      framing: "ecosystem",
      framingMaturedAt: "2026-07-15T12:00:00.000Z",
      title: "RH Chain regime",
      lastSeen: "2026-07-16T12:00:00.000Z",
    })
  })

  it("merges a maturity proposal into an existing log via mergeNarrativeProposals", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-narrative-merge-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "state", "narratives"), { recursive: true })
    mkdirSync(join(agentRoot, "reports", RUN_ID), { recursive: true })
    const prior = entry({
      slug: "rh-chain-meme-rotation",
      title: "Robinhood chain meme rotation",
      firstSeen: "2026-07-01T00:00:00.000Z",
      lastSeen: "2026-07-14T12:00:00.000Z",
    })
    writeFileSync(
      join(agentRoot, "state", "narratives", "log.jsonl"),
      `${JSON.stringify(prior)}\n`,
    )
    const proposal = {
      ...prior,
      title: "RH Chain agent infra",
      lastSeen: "2026-07-16T12:00:00.000Z",
      evidence: ["twitter:@alice:1", "twitter:@bob:2"],
      framing: "ecosystem",
      framingMaturedAt: "2026-07-16T12:00:00.000Z",
      framingEvidence: ["twitter:@bob:2"],
    }
    writeFileSync(
      join(agentRoot, "reports", RUN_ID, "narrative-proposals.jsonl"),
      `${JSON.stringify(proposal)}\n`,
    )
    const report = await mergeNarrativeProposals({
      agentRoot,
      runId: RUN_ID,
      nowIso: NOW,
    })
    expect(report.malformed).toBe(0)
    const log = readFileSync(join(agentRoot, "state", "narratives", "log.jsonl"), "utf8")
    const parsed = JSON.parse(log.trim())
    expect(parsed).toMatchObject({
      slug: "rh-chain-meme-rotation",
      title: "RH Chain agent infra",
      framing: "ecosystem",
      firstSeen: "2026-07-01T00:00:00.000Z",
    })
  })
})

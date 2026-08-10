import { describe, expect, it } from "vitest"
import {
  mkdirSync,
  writeFileSync,
  utimesSync,
  existsSync,
  mkdtempSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  retainByAge,
  retainAlphaAckTombstones,
  retainNarrativeDossiers,
  retainWorkspaceArtifacts,
} from "../../src/orchestrator/retention.js"

const DAY_MS = 86_400_000

function ageFile(path: string, ageDays: number): void {
  const ms = Date.now() - ageDays * DAY_MS
  utimesSync(path, ms / 1000, ms / 1000)
}

describe("workspace retention", () => {
  it("prunes old inbox dirs and chat reports but never archive", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-retain-"))
    const inboxOld = join(root, "inbox", "old-run")
    const inboxNew = join(root, "inbox", "new-run")
    const chatOld = join(root, "reports", "chat", "old.md")
    const chatNew = join(root, "reports", "chat", "new.md")
    const archiveProbe = join(root, "archive", "runs", "sealed")
    mkdirSync(inboxOld, { recursive: true })
    mkdirSync(inboxNew, { recursive: true })
    mkdirSync(join(root, "reports", "chat"), { recursive: true })
    mkdirSync(archiveProbe, { recursive: true })
    writeFileSync(join(inboxOld, "meta.json"), "{}\n")
    writeFileSync(join(inboxNew, "meta.json"), "{}\n")
    writeFileSync(chatOld, "old\n")
    writeFileSync(chatNew, "new\n")
    writeFileSync(join(archiveProbe, "keep.json"), "{}\n")

    const oldMs = Date.now() - 40 * DAY_MS
    const newMs = Date.now() - 1 * DAY_MS
    utimesSync(inboxOld, oldMs / 1000, oldMs / 1000)
    utimesSync(inboxNew, newMs / 1000, newMs / 1000)
    utimesSync(chatOld, oldMs / 1000, oldMs / 1000)
    utimesSync(chatNew, newMs / 1000, newMs / 1000)

    const report = retainWorkspaceArtifacts({
      agentRoot: root,
      inboxMaxAgeDays: 30,
      chatReportsMaxAgeDays: 30,
      alphaAckMaxAgeDays: 30,
      narrativeDossierMaxAgeDays: 120,
    })
    expect(existsSync(inboxOld)).toBe(false)
    expect(existsSync(inboxNew)).toBe(true)
    expect(existsSync(chatOld)).toBe(false)
    expect(existsSync(chatNew)).toBe(true)
    expect(existsSync(join(archiveProbe, "keep.json"))).toBe(true)
    expect(report.inboxRemoved.length).toBe(1)
    expect(report.chatReportsRemoved.length).toBe(1)
    expect(report.alphaAcksRemoved).toEqual([])
    expect(report.narrativeDossiersRemoved).toEqual([])
  })

  it("refuses to run retainByAge outside expected parent", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-retain-escape-"))
    const outside = join(root, "..", "not-under-agent")
    expect(() => retainByAge(outside, 30, Date.now(), { expectedParent: root }))
      .toThrow(/escapes expected parent/u)
  })
})

describe("alpha-ack tombstone retention", () => {
  function scaffold(): string {
    const root = mkdtempSync(join(tmpdir(), "tc-retain-ack-"))
    mkdirSync(join(root, "state", "alpha-acks"), { recursive: true })
    mkdirSync(join(root, "state", "research"), { recursive: true })
    mkdirSync(join(root, "alpha-queue", "Chan"), { recursive: true })
    return root
  }

  it("deletes an aged ack once the queue message is purged", () => {
    const root = scaffold()
    const ack = join(root, "state", "alpha-acks", "Chan-1.md")
    writeFileSync(ack, "# Alpha ack\n")
    ageFile(ack, 45)

    const removed = retainAlphaAckTombstones({ agentRoot: root, maxAgeDays: 30 })
    expect(removed).toEqual([ack])
    expect(existsSync(ack)).toBe(false)
  })

  it("keeps an ack at any age while its queue message exists", () => {
    const root = scaffold()
    const ack = join(root, "state", "alpha-acks", "Chan-2.md")
    writeFileSync(ack, "# Alpha ack\n")
    writeFileSync(join(root, "alpha-queue", "Chan", "2.json"), "{}\n")
    ageFile(ack, 400)

    const removed = retainAlphaAckTombstones({ agentRoot: root, maxAgeDays: 30 })
    expect(removed).toEqual([])
    expect(existsSync(ack)).toBe(true)
  })

  it("keeps a young ack", () => {
    const root = scaffold()
    const ack = join(root, "state", "alpha-acks", "Chan-3.md")
    writeFileSync(ack, "# Alpha ack\n")
    ageFile(ack, 5)

    const removed = retainAlphaAckTombstones({ agentRoot: root, maxAgeDays: 30 })
    expect(removed).toEqual([])
    expect(existsSync(ack)).toBe(true)
  })

  it("sweeps legacy research acks but never token dossiers", () => {
    const root = scaffold()
    const legacy = join(root, "state", "research", "alpha-ack-Chan-4.md")
    const dossier = join(root, "state", "research", "TOKEN.md")
    writeFileSync(legacy, "# Alpha ack\n")
    writeFileSync(dossier, "# TOKEN dossier\n")
    ageFile(legacy, 45)
    ageFile(dossier, 400)

    const removed = retainAlphaAckTombstones({ agentRoot: root, maxAgeDays: 30 })
    expect(removed).toEqual([legacy])
    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(dossier)).toBe(true)
  })

  it("parses hyphenated channels and honours their pending queue message", () => {
    const root = scaffold()
    mkdirSync(join(root, "alpha-queue", "some-chan"), { recursive: true })
    const pending = join(root, "state", "research", "alpha-ack-some-chan-123.md")
    const purged = join(root, "state", "alpha-acks", "some-chan-124.md")
    writeFileSync(pending, "# Alpha ack\n")
    writeFileSync(purged, "# Alpha ack\n")
    writeFileSync(join(root, "alpha-queue", "some-chan", "123.json"), "{}\n")
    ageFile(pending, 45)
    ageFile(purged, 45)

    const removed = retainAlphaAckTombstones({ agentRoot: root, maxAgeDays: 30 })
    expect(removed).toEqual([purged])
    expect(existsSync(pending)).toBe(true)
  })

  it("rejects an invalid max age", () => {
    const root = scaffold()
    expect(() => retainAlphaAckTombstones({ agentRoot: root, maxAgeDays: 0 }))
      .toThrow(/invalid maxAgeDays/u)
  })
})

describe("narrative dossier retention", () => {
  function scaffold(logLines: readonly string[]): string {
    const root = mkdtempSync(join(tmpdir(), "tc-retain-dossier-"))
    mkdirSync(join(root, "state", "narratives"), { recursive: true })
    if (logLines.length > 0) {
      writeFileSync(
        join(root, "state", "narratives", "log.jsonl"),
        `${logLines.join("\n")}\n`,
      )
    }
    return root
  }

  const activeLine = JSON.stringify({
    slug: "base-ai",
    title: "Base AI agents",
    firstSeen: "2026-07-10T12:00:00.000Z",
    lastSeen: "2026-08-09T12:00:00.000Z",
    evidence: ["twitter:@handle:123"],
    stage: "peaking",
  })

  it("deletes an aged dossier whose slug left the log", () => {
    const root = scaffold([activeLine])
    const gone = join(root, "state", "narratives", "dead-meta.md")
    writeFileSync(gone, "---\nstatus: dormant\n---\n")
    ageFile(gone, 150)

    const removed = retainNarrativeDossiers({ agentRoot: root, maxAgeDays: 120 })
    expect(removed).toEqual([gone])
    expect(existsSync(gone)).toBe(false)
  })

  it("keeps a dossier for an active slug at any age", () => {
    const root = scaffold([activeLine])
    const active = join(root, "state", "narratives", "base-ai.md")
    writeFileSync(active, "---\nstatus: active\n---\n")
    ageFile(active, 400)

    const removed = retainNarrativeDossiers({ agentRoot: root, maxAgeDays: 120 })
    expect(removed).toEqual([])
    expect(existsSync(active)).toBe(true)
  })

  it("keeps a young dormant dossier", () => {
    const root = scaffold([activeLine])
    const young = join(root, "state", "narratives", "quiet-meta.md")
    writeFileSync(young, "---\nstatus: dormant\n---\n")
    ageFile(young, 30)

    const removed = retainNarrativeDossiers({ agentRoot: root, maxAgeDays: 120 })
    expect(removed).toEqual([])
    expect(existsSync(young)).toBe(true)
  })

  it("never deletes log.jsonl", () => {
    const root = scaffold([activeLine])
    const log = join(root, "state", "narratives", "log.jsonl")
    ageFile(log, 400)

    const removed = retainNarrativeDossiers({ agentRoot: root, maxAgeDays: 120 })
    expect(removed).toEqual([])
    expect(existsSync(log)).toBe(true)
  })

  it("skips malformed log lines but keeps their well-formed neighbours", () => {
    const root = scaffold(["not json", activeLine])
    const active = join(root, "state", "narratives", "base-ai.md")
    writeFileSync(active, "---\nstatus: active\n---\n")
    ageFile(active, 400)

    const removed = retainNarrativeDossiers({ agentRoot: root, maxAgeDays: 120 })
    expect(removed).toEqual([])
    expect(existsSync(active)).toBe(true)
  })
})

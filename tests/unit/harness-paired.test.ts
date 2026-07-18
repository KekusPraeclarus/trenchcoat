import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  countMaturePaired,
  loadPairedEpisode,
  recordPairedEpisode,
} from "../../src/harness/paired.js"

const INBOX = `sha256:${"a".repeat(64)}` as const

function base(archiveRoot: string, episodeId: string) {
  return {
    archiveRoot,
    episodeId,
    runId: "run-1",
    frozenInboxHash: INBOX,
    candidatePolicyVersion: "candidate:hyp",
    baselinePolicyVersion: "baseline",
    recordedAt: "2026-07-17T00:00:00.000Z",
  }
}

describe("recordPairedEpisode", () => {
  it("marks candidateMutated when the proposals diverge on the same frozen inbox", async () => {
    const archiveRoot = join(mkdtempSync(join(tmpdir(), "tc-paired-")), "archive")
    const record = await recordPairedEpisode({
      ...base(archiveRoot, "ep-diverge"),
      candidateProposal: { verdict: "track", confidence: 80 },
      baselineProposal: { verdict: "ignore", confidence: 20 },
    })
    expect(record.candidateMutated).toBe(true)
    expect(record.baselineMutated).toBe(false)
    expect(record.candidateProposalHash).not.toBe(record.baselineProposalHash)
    expect(loadPairedEpisode(archiveRoot, "ep-diverge")).toEqual(record)
  })

  it("clears candidateMutated when identical proposals hash the same", async () => {
    const archiveRoot = join(mkdtempSync(join(tmpdir(), "tc-paired-")), "archive")
    const record = await recordPairedEpisode({
      ...base(archiveRoot, "ep-same"),
      // key order differs but canonical hash is identical
      candidateProposal: { verdict: "track", confidence: 80 },
      baselineProposal: { confidence: 80, verdict: "track" },
    })
    expect(record.candidateMutated).toBe(false)
    expect(record.candidateProposalHash).toBe(record.baselineProposalHash)
  })

  it("always keeps baselineMutated false even if only baseline is present", async () => {
    const archiveRoot = join(mkdtempSync(join(tmpdir(), "tc-paired-")), "archive")
    const record = await recordPairedEpisode({
      ...base(archiveRoot, "ep-baseline"),
      baselineProposal: { verdict: "drop" },
    })
    expect(record.baselineMutated).toBe(false)
    expect(record.candidateMutated).toBe(false)
    expect(record.candidateProposalHash).toBeUndefined()
  })

  it("counts only mature paired episodes", async () => {
    const archiveRoot = join(mkdtempSync(join(tmpdir(), "tc-paired-")), "archive")
    await recordPairedEpisode({ ...base(archiveRoot, "ep-a"), mature: true })
    await recordPairedEpisode({ ...base(archiveRoot, "ep-b"), mature: false })
    await recordPairedEpisode({ ...base(archiveRoot, "ep-c"), mature: true })
    expect(countMaturePaired(archiveRoot)).toBe(2)
  })
})

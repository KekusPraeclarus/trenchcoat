import { describe, expect, it } from "vitest"
import type { MarketClaimRecord } from "../../src/orchestrator/market-claims.js"
import {
  assertEvidenceFetchedAfter,
  citationsAllowlisted,
  deterministicContradiction,
  hasDeterministicCheck,
  mergeVerdicts,
} from "../../src/remediation/revalidate.js"
import type { ClaimRevalidationResult } from "../../src/remediation/schemas.js"

const CLAIM_ID = "mc_b_" + "c".repeat(24)
const REF_A = "archive/runs/r1/inbox"
const REF_B = "archive/runs/r2/inbox"

function result(
  verdict: ClaimRevalidationResult["verdict"],
  overrides?: Partial<ClaimRevalidationResult>,
): ClaimRevalidationResult {
  return {
    schema: 1,
    claimId: CLAIM_ID,
    verdict,
    reason: overrides?.reason ?? `${verdict}-reason`,
    evidenceRefs: overrides?.evidenceRefs ?? [REF_A],
    uncertainty: overrides?.uncertainty ?? [],
    ...overrides,
  }
}

function broadcastClaim(overrides?: Partial<MarketClaimRecord>): MarketClaimRecord {
  return {
    schema: 1,
    claimId: CLAIM_ID,
    kind: "broadcast",
    runId: "run-1",
    occurredAt: "2026-07-21T02:00:00.000Z",
    subject: "sol-memes",
    summary: "peaking",
    provenanceIds: [],
    refs: [REF_A],
    destinations: ["telegram"],
    ...overrides,
  }
}

describe("mergeVerdicts", () => {
  const allowlist = new Set([REF_A, REF_B])

  it("merges unanimous stands", () => {
    const merged = mergeVerdicts({
      claimId: CLAIM_ID,
      evaluator: result("stands"),
      reviewer: result("stands"),
      deterministicInvalidated: false,
      allowlist,
    })
    expect(merged.verdict).toBe("stands")
  })

  it("citation allowlist fail → inconclusive", () => {
    const merged = mergeVerdicts({
      claimId: CLAIM_ID,
      evaluator: result("invalidated", { evidenceRefs: ["fabricated/path"] }),
      reviewer: result("invalidated"),
      deterministicInvalidated: false,
      allowlist,
    })
    expect(merged.verdict).toBe("inconclusive")
    expect(merged.reason).toBe("citation-not-allowlisted")
  })

  it("deterministic available + no contradiction blocks invalidation", () => {
    const merged = mergeVerdicts({
      claimId: CLAIM_ID,
      evaluator: result("invalidated"),
      reviewer: result("invalidated"),
      deterministicInvalidated: false,
      deterministicAvailable: true,
      allowlist,
    })
    expect(merged.verdict).toBe("inconclusive")
    expect(merged.uncertainty).toContain("no-deterministic-contradiction")
  })

  it("both agree invalidated + zero uncertainty + citations → invalidated for broadcasts without det check", () => {
    const claim = broadcastClaim()
    expect(hasDeterministicCheck(claim)).toBe(false)
    const merged = mergeVerdicts({
      claimId: CLAIM_ID,
      evaluator: result("invalidated", { evidenceRefs: [REF_A, REF_B] }),
      reviewer: result("invalidated", { evidenceRefs: [REF_B] }),
      deterministicInvalidated: false,
      deterministicAvailable: hasDeterministicCheck(claim),
      allowlist,
    })
    expect(merged.verdict).toBe("invalidated")
    expect(merged.evidenceRefs.sort()).toEqual([REF_A, REF_B].sort())
  })

  it("reviewer disagreement → inconclusive", () => {
    const merged = mergeVerdicts({
      claimId: CLAIM_ID,
      evaluator: result("invalidated"),
      reviewer: result("stands"),
      deterministicInvalidated: false,
      allowlist,
    })
    expect(merged.verdict).toBe("inconclusive")
    expect(merged.reason).toBe("evaluator-reviewer-disagreement-or-uncertainty")
  })
})

describe("citationsAllowlisted", () => {
  it("requires non-empty allowlisted citations", () => {
    const allow = new Set([REF_A])
    expect(citationsAllowlisted([], allow)).toBe(false)
    expect(citationsAllowlisted([REF_A], allow)).toBe(true)
    expect(citationsAllowlisted([REF_A, "x"], allow)).toBe(false)
  })
})

describe("deterministicContradiction", () => {
  it("detects narrative stage reversal", () => {
    const claim = broadcastClaim({
      kind: "narrative-stage",
      narrativeStage: "fading",
      claimId: "mc_n_" + "n".repeat(24),
    })
    expect(hasDeterministicCheck(claim)).toBe(true)
    expect(deterministicContradiction({
      claim,
      currentNarrativeStage: "peaking",
    })).toBe(true)
    expect(deterministicContradiction({
      claim,
      currentNarrativeStage: "fading",
    })).toBe(false)
  })
})

describe("assertEvidenceFetchedAfter", () => {
  it("rejects stale or pre-fix evidence", () => {
    const deployedAt = "2026-07-21T03:00:00.000Z"
    const ok = assertEvidenceFetchedAfter(
      ["/tmp/evidence-a.json"],
      deployedAt,
      () => "2026-07-21T03:10:00.000Z",
    )
    expect(ok).toEqual({ ok: true })

    const stale = assertEvidenceFetchedAfter(
      ["/tmp/evidence-b.json"],
      deployedAt,
      () => "2026-07-21T02:59:00.000Z",
    )
    expect(stale.ok).toBe(false)
    if (!stale.ok) {
      expect(stale.reason).toContain("stale-or-pre-fix")
    }
  })
})

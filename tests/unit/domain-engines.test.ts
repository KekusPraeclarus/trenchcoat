import { describe, expect, it } from "vitest"
import { validateModelPick, resolveFromCandidates } from "../../src/lib/resolve.js"
import { meanScore, initialSourceScore, observeHit } from "../../src/lib/source-scoring.js"
import { openEntryPending, finalizeEntry, firstEligibleObservation } from "../../src/orchestrator/ledger.js"
import { brierScore, applyFeeBps } from "../../src/orchestrator/audit-math.js"
import { buildWalletTransition, applyTransitionsCap } from "../../src/wallets/lifecycle.js"

describe("deterministic domain engines", () => {
  it("prop_inv_s9_and_s16_rejects picks outside supported shortlist", () => {
    expect(validateModelPick([], "injected")).toBeUndefined()
  })

  it("prop_inv_s10_opens pending and finalizes first post-decision observation", () => {
    const resolved = resolveFromCandidates([{
      chain: "solana",
      tokenAddress: "11111111111111111111111111111111",
      pairAddress: "11111111111111111111111111111111",
      symbolDisplay: "SOL",
      liquidityUsd: 1,
      volume24hUsd: 1,
    }])
    expect(resolved.status).toBe("resolved")
    if (resolved.status !== "resolved") return
    const pending = openEntryPending({
      positionId: "pos-1",
      decisionId: "decision-1",
      identity: resolved.identity,
      openedAt: "2026-01-01T00:00:00.000Z",
    })
    const obs = firstEligibleObservation("2026-01-01T00:00:00.000Z", [
      { ts: "2026-01-01T00:05:00.000Z", open: 1, hash: `sha256:${"a".repeat(64)}` },
    ])
    const open = finalizeEntry(pending, obs!)
    expect(open.entryPrice).toBe(1)
  })

  it("prop_inv_s14_uses deterministic scoring maths", () => {
    expect(applyFeeBps(0.2, 50)).toBeCloseTo(0.19)
    const score = observeHit(initialSourceScore(10), true, 1)
    expect(meanScore(score)).toBeGreaterThan(0.5)
    expect(brierScore([0.5], [1])).toBe(0.25)
  })

  it("prop_inv_s20_transition cap queues excess", () => {
    const wallet = {
      schema: 1 as const,
      walletId: "wallet-1",
      chain: "solana" as const,
      address: "11111111111111111111111111111111",
      status: "tracking-probation" as const,
      addedAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      hardExcluded: false,
    }
    const transition = buildWalletTransition({
      wallet,
      action: "added",
      reasonCode: "operator-seed",
      reasonLine: "operator seed",
      occurredAt: "2026-07-16T00:00:00.000Z",
      runId: "run-1",
      evidenceHash: `sha256:${"a".repeat(64)}`,
    })
    const { applied, queued } = applyTransitionsCap([transition, transition], 1)
    expect(applied).toHaveLength(1)
    expect(queued).toHaveLength(1)
  })
})

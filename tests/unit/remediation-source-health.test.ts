import { describe, expect, it } from "vitest"
import {
  SOURCE_KIND_X_HOME_FYP,
  appendSourceHealthObservation,
  classifyXScanObservation,
  computeImpactWindow,
  emptySourceHealthLedger,
  hasPostFixRecoveryProof,
} from "../../src/remediation/source-health.js"
import type { SourceHealthObservation } from "../../src/remediation/schemas.js"

const COMMIT = "abcdef1234567"
const OTHER = "zzzzzzz9999999"

function obs(partial: Partial<SourceHealthObservation> & Pick<
  SourceHealthObservation,
  "observationId" | "observedAt" | "status"
>): SourceHealthObservation {
  return {
    schema: 1,
    sourceKind: SOURCE_KIND_X_HOME_FYP,
    target: "home",
    ...partial,
  }
}

describe("classifyXScanObservation", () => {
  it("empty FYP without cursor is unhealthy", () => {
    const o = classifyXScanObservation({
      targetKind: "home",
      targetLabel: "home",
      observedAt: "2026-07-21T01:00:00.000Z",
      postCount: 0,
      hitCursor: false,
      challenged: false,
    })
    expect(o.status).toBe("unhealthy")
    expect(o.reason).toBe("empty-without-cursor")
    expect(o.sourceKind).toBe(SOURCE_KIND_X_HOME_FYP)
  })

  it("non-empty FYP is healthy", () => {
    const o = classifyXScanObservation({
      targetKind: "home",
      targetLabel: "home",
      observedAt: "2026-07-21T01:00:00.000Z",
      postCount: 3,
      hitCursor: false,
      challenged: false,
    })
    expect(o.status).toBe("healthy")
    expect(o.reason).toBe("posts-present")
  })
})

describe("computeImpactWindow", () => {
  it("uses conservative (last healthy before first unhealthy, recovery end]", () => {
    const observations = [
      obs({
        observationId: "sho_healthy_prior________",
        observedAt: "2026-07-21T01:00:00.000Z",
        status: "healthy",
        postCount: 5,
      }),
      obs({
        observationId: "sho_unhealthy_first______",
        observedAt: "2026-07-21T02:00:00.000Z",
        status: "unhealthy",
        postCount: 0,
      }),
      obs({
        observationId: "sho_healthy_recover______",
        observedAt: "2026-07-21T04:00:00.000Z",
        status: "healthy",
        postCount: 2,
      }),
    ]
    const window = computeImpactWindow({
      observations,
      sourceKinds: [SOURCE_KIND_X_HOME_FYP],
      recoveryConfirmedAt: "2026-07-21T04:00:00.000Z",
    })
    expect(window.ok).toBe(true)
    expect(window.startExclusive).toBe("2026-07-21T01:00:00.000Z")
    expect(window.endInclusive).toBe("2026-07-21T04:00:00.000Z")
  })

  it("returns impact-window-unknown when no prior healthy", () => {
    const window = computeImpactWindow({
      observations: [
        obs({
          observationId: "sho_unhealthy_only_______",
          observedAt: "2026-07-21T02:00:00.000Z",
          status: "unhealthy",
          postCount: 0,
        }),
      ],
      sourceKinds: [SOURCE_KIND_X_HOME_FYP],
    })
    expect(window.ok).toBe(false)
    expect(window.reason).toBe("impact-window-unknown")
  })
})

describe("hasPostFixRecoveryProof", () => {
  const deployedAt = "2026-07-21T03:00:00.000Z"

  it("rejects wrong commit and stale pre-deploy observations", () => {
    const wrongCommit = hasPostFixRecoveryProof({
      observations: [
        obs({
          observationId: "sho_wrong_commit_________",
          observedAt: "2026-07-21T03:10:00.000Z",
          status: "healthy",
          postCount: 4,
          sourceCommit: OTHER,
        }),
        obs({
          observationId: "sho_wrong_commit_2_______",
          observedAt: "2026-07-21T03:20:00.000Z",
          status: "healthy",
          postCount: 3,
          sourceCommit: OTHER,
        }),
      ],
      sourceKinds: [SOURCE_KIND_X_HOME_FYP],
      deployedAt,
      sourceCommit: COMMIT,
      requiredHealthy: 2,
    })
    expect(wrongCommit.ok).toBe(false)

    const stale = hasPostFixRecoveryProof({
      observations: [
        obs({
          observationId: "sho_stale_pre_deploy_____",
          observedAt: "2026-07-21T02:50:00.000Z",
          status: "healthy",
          postCount: 4,
          sourceCommit: COMMIT,
        }),
        obs({
          observationId: "sho_stale_pre_deploy_2___",
          observedAt: "2026-07-21T02:55:00.000Z",
          status: "healthy",
          postCount: 3,
          sourceCommit: COMMIT,
        }),
      ],
      sourceKinds: [SOURCE_KIND_X_HOME_FYP],
      deployedAt,
      sourceCommit: COMMIT,
      requiredHealthy: 2,
    })
    expect(stale.ok).toBe(false)
  })

  it("requires two healthy post-deploy observations from deployed commit", () => {
    const one = hasPostFixRecoveryProof({
      observations: [
        obs({
          observationId: "sho_one_healthy__________",
          observedAt: "2026-07-21T03:10:00.000Z",
          status: "healthy",
          postCount: 4,
          sourceCommit: COMMIT,
        }),
      ],
      sourceKinds: [SOURCE_KIND_X_HOME_FYP],
      deployedAt,
      sourceCommit: COMMIT,
      requiredHealthy: 2,
    })
    expect(one.ok).toBe(false)
    expect(one.healthyCount).toBe(1)

    const two = hasPostFixRecoveryProof({
      observations: [
        obs({
          observationId: "sho_two_a________________",
          observedAt: "2026-07-21T03:10:00.000Z",
          status: "healthy",
          postCount: 4,
          sourceCommit: COMMIT,
        }),
        obs({
          observationId: "sho_two_b________________",
          observedAt: "2026-07-21T03:20:00.000Z",
          status: "healthy",
          postCount: 2,
          sourceCommit: COMMIT,
        }),
      ],
      sourceKinds: [SOURCE_KIND_X_HOME_FYP],
      deployedAt,
      sourceCommit: COMMIT,
      requiredHealthy: 2,
    })
    expect(two.ok).toBe(true)
    expect(two.recoveryConfirmedAt).toBe("2026-07-21T03:20:00.000Z")
  })

  it("FYP recovery needs posts (idle-caught-up without posts does not count)", () => {
    const proof = hasPostFixRecoveryProof({
      observations: [
        obs({
          observationId: "sho_idle_a_______________",
          observedAt: "2026-07-21T03:10:00.000Z",
          status: "healthy",
          postCount: 0,
          hitCursor: true,
          sourceCommit: COMMIT,
          reason: "idle-caught-up",
        }),
        obs({
          observationId: "sho_idle_b_______________",
          observedAt: "2026-07-21T03:20:00.000Z",
          status: "healthy",
          postCount: 0,
          hitCursor: true,
          sourceCommit: COMMIT,
          reason: "idle-caught-up",
        }),
      ],
      sourceKinds: [SOURCE_KIND_X_HOME_FYP],
      deployedAt,
      sourceCommit: COMMIT,
      requiredHealthy: 2,
    })
    expect(proof.ok).toBe(false)
    expect(proof.healthyCount).toBe(0)
  })
})

describe("appendSourceHealthObservation", () => {
  it("is idempotent on observationId", () => {
    const o = classifyXScanObservation({
      targetKind: "home",
      targetLabel: "home",
      observedAt: "2026-07-21T01:00:00.000Z",
      postCount: 1,
      hitCursor: false,
      challenged: false,
      sourceCommit: COMMIT,
    })
    let ledger = emptySourceHealthLedger()
    ledger = appendSourceHealthObservation(ledger, o)
    ledger = appendSourceHealthObservation(ledger, o)
    expect(ledger.observations).toHaveLength(1)
  })
})

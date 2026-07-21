import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
  emptyMarketClaimValidityIndex,
  upsertClaimValidity,
} from "../../src/orchestrator/market-claims.js"
import { correctionEventId } from "../../src/remediation/correction.js"
import {
  SOURCE_KIND_X_HOME_FYP,
  hasPostFixRecoveryProof,
} from "../../src/remediation/source-health.js"
import type { SourceHealthObservation } from "../../src/remediation/schemas.js"

const COMMIT = "abcdef1234567"
const DEPLOYED = "2026-07-21T12:00:00.000Z"

describe("prop_inv_s28_no_fresh_proof_no_verdict", () => {
  it("hasPostFixRecoveryProof is false for wrong commit / pre-deploy / insufficient count", () => {
    fc.assert(fc.property(
      fc.constantFrom("wrong-commit", "pre-deploy", "insufficient"),
      fc.integer({ min: 1, max: 3 }),
      (mode, n) => {
        const observations: SourceHealthObservation[] = []
        for (let i = 0; i < n; i += 1) {
          const observedAt = mode === "pre-deploy"
            ? `2026-07-21T11:0${i}:00.000Z`
            : `2026-07-21T12:1${i}:00.000Z`
          observations.push({
            schema: 1,
            observationId: `sho_prop_${mode}_${i}`.padEnd(24, "0").slice(0, 28),
            sourceKind: SOURCE_KIND_X_HOME_FYP,
            target: "home",
            observedAt,
            status: "healthy",
            postCount: mode === "insufficient" && i === 0 ? 2 : (mode === "insufficient" ? 0 : 2),
            sourceCommit: mode === "wrong-commit" ? "zzzzzzz9999999" : COMMIT,
          })
        }
        const requiredHealthy = mode === "insufficient" ? Math.max(n + 1, 2) : 2
        const proof = hasPostFixRecoveryProof({
          observations,
          sourceKinds: [SOURCE_KIND_X_HOME_FYP],
          deployedAt: DEPLOYED,
          sourceCommit: COMMIT,
          requiredHealthy,
        })
        expect(proof.ok).toBe(false)
      },
    ), { numRuns: 40 })
  })
})

describe("prop_inv_s28_append_only_validity", () => {
  it("upsertClaimValidity never removes prior entries for other claim ids", () => {
    fc.assert(fc.property(
      fc.array(fc.stringMatching(/^[a-z0-9]{16}$/u), { minLength: 1, maxLength: 8 }),
      fc.stringMatching(/^[a-z0-9]{16}$/u),
      (ids, extra) => {
        const unique = [...new Set(ids)]
        let index = emptyMarketClaimValidityIndex()
        for (const id of unique) {
          index = upsertClaimValidity(index, {
            schema: 1,
            claimId: `mc_b_${id}xxxxxxxx`.slice(0, 32),
            validity: "stands",
            updatedAt: "2026-07-21T01:00:00.000Z",
          })
        }
        const beforeIds = new Set(index.entries.map((e) => e.claimId))
        const updateId = `mc_b_${extra}xxxxxxxx`.slice(0, 32)
        index = upsertClaimValidity(index, {
          schema: 1,
          claimId: updateId,
          validity: "invalidated",
          updatedAt: "2026-07-21T02:00:00.000Z",
          reason: "prop",
        })
        for (const id of beforeIds) {
          if (id === updateId) continue
          expect(index.entries.some((e) => e.claimId === id)).toBe(true)
        }
      },
    ), { numRuns: 30 })
  })
})

describe("prop_inv_s28_one_correction_event_id", () => {
  it("same incident+destination+claimIds → same eventId", () => {
    fc.assert(fc.property(
      fc.stringMatching(/^rem-[a-z0-9]{12}$/u),
      fc.constantFrom("telegram", "discord") as fc.Arbitrary<"telegram" | "discord">,
      fc.array(fc.stringMatching(/^mc_b_[a-z0-9]{24}$/u), { minLength: 1, maxLength: 5 }),
      (incidentId, destination, claimIds) => {
        const a = correctionEventId({ incidentId, destination, claimIds })
        const b = correctionEventId({
          incidentId,
          destination,
          claimIds: [...claimIds].reverse(),
        })
        expect(a).toBe(b)
      },
    ), { numRuns: 40 })
  })
})

describe("prop_inv_s28_replay_idempotent", () => {
  it("correctionEventId is deterministic across replays", () => {
    fc.assert(fc.property(
      fc.stringMatching(/^rem-[a-z0-9]{12}$/u),
      fc.array(fc.stringMatching(/^mc_b_[a-z0-9]{24}$/u), { minLength: 1, maxLength: 4 }),
      (incidentId, claimIds) => {
        const first = correctionEventId({
          incidentId,
          destination: "telegram",
          claimIds,
        })
        for (let i = 0; i < 5; i += 1) {
          expect(correctionEventId({
            incidentId,
            destination: "telegram",
            claimIds,
          })).toBe(first)
        }
      },
    ), { numRuns: 30 })
  })
})

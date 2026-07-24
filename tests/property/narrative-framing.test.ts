import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import {
  preferredNarrativeLabel,
  usesStaleRotationFraming,
} from "../../src/lib/narrative-label.js"
import { pruneNarrativeLogInMemory } from "../../src/orchestrator/narrative-log.js"

const NOW = "2026-07-17T12:00:00.000Z"

describe("prop_inv_b2_stale_rotation_framing_never_stages", () => {
  it("detects alias + rotation wording against matured entries", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("rh", "robinhood", "infra"),
        fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !/\brotation\b/iu.test(s)),
        (alias, filler) => {
          const matured = {
            slug: "rh-chain-meme-rotation",
            title: "RH Chain agent infra",
            framing: "ecosystem" as const,
          }
          const text = `${alias} rotation ${filler}`
          expect(usesStaleRotationFraming(text, [matured])).toBe(true)
        },
      ),
      { numRuns: 40 },
    )
  })
})

describe("prop_inv_s23_framing_never_regresses", () => {
  it("keeps earlier mature framing across later rotation-shaped proposals", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("ecosystem", "regime") as fc.Arbitrary<"ecosystem" | "regime">,
        fc.integer({ min: 1, max: 5 }),
        (framing, dayOffset) => {
          const matureAt = `2026-07-${String(10 + dayOffset).padStart(2, "0")}T12:00:00.000Z`
          const later = `2026-07-${String(11 + dayOffset).padStart(2, "0")}T12:00:00.000Z`
          const prior = {
            slug: "rh-chain-meme-rotation",
            title: "RH Chain agent infra",
            firstSeen: "2026-07-01T12:00:00.000Z",
            lastSeen: matureAt,
            evidence: ["twitter:@alice:1"],
            stage: "peaking" as const,
            framing,
            framingMaturedAt: matureAt,
            framingEvidence: ["twitter:@bob:2"],
          }
          const next = {
            slug: "rh-chain-meme-rotation",
            title: "RH Chain agent infra",
            firstSeen: "2026-07-01T12:00:00.000Z",
            lastSeen: later,
            evidence: ["twitter:@carol:3"],
            stage: "peaking" as const,
            framing: "rotation" as const,
          }
          const result = pruneNarrativeLogInMemory(
            `${JSON.stringify(prior)}\n${JSON.stringify(next)}\n`,
            NOW,
            14,
          )
          expect(result.entries).toHaveLength(1)
          expect(result.entries[0]?.framing).toBe(framing)
          expect(result.entries[0]?.framingMaturedAt).toBe(matureAt)
          expect(preferredNarrativeLabel(result.entries[0]!)).toBe("RH Chain agent infra")
        },
      ),
      { numRuns: 20 },
    )
  })
})

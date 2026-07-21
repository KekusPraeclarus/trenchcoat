import { describe, expect, it } from "vitest"
import type { MarketClaimRecord } from "../../src/orchestrator/market-claims.js"
import {
  buildCorrectionPayloads,
  claimsForDestination,
  correctionEventId,
  renderCorrectionFallback,
  singleDiscordReplyTarget,
} from "../../src/remediation/correction.js"
import type { ClaimRevalidationResult } from "../../src/remediation/schemas.js"

const CLAIM_TG = "mc_b_" + "t".repeat(24)
const CLAIM_DC = "mc_b_" + "d".repeat(24)
const CLAIM_BOTH = "mc_b_" + "b".repeat(24)
const EVENT_ID = "sha256:" + "e".repeat(64)

function claim(partial: Partial<MarketClaimRecord> & Pick<MarketClaimRecord, "claimId">): MarketClaimRecord {
  return {
    schema: 1,
    kind: "broadcast",
    runId: "run-1",
    occurredAt: "2026-07-21T02:00:00.000Z",
    subject: "sol-memes",
    summary: "watch @evil_handle via agent/state/secret.json",
    provenanceIds: [],
    refs: [],
    destinations: ["telegram"],
    ...partial,
  }
}

function invalidated(claimId: string, reason = "source empty during outage"): ClaimRevalidationResult {
  return {
    schema: 1,
    claimId,
    verdict: "invalidated",
    reason,
    evidenceRefs: ["archive/runs/r1/inbox"],
    uncertainty: [],
  }
}

describe("renderCorrectionFallback", () => {
  it("uses Telegram vs Discord voice", () => {
    const claims = [claim({ claimId: CLAIM_TG, subject: "sol-memes" })]
    const results = [invalidated(CLAIM_TG)]
    const tg = renderCorrectionFallback({
      claims,
      results,
      recoveredSource: "x-home-fyp",
      destination: "telegram",
    })
    expect(tg).toContain("**Invalidated**")
    expect(tg).toContain("sol-memes")
    expect(tg).toContain("x-home-fyp is healthy again")

    const dc = renderCorrectionFallback({
      claims,
      results,
      recoveredSource: "x-home-fyp",
      destination: "discord",
    })
    expect(dc).toContain("Update: prior call(s) on sol-memes")
    expect(dc).toContain("x-home-fyp recovered")
    expect(dc).not.toContain("**Invalidated**")
  })

  it("consolidates multi-claim discord subjects", () => {
    const claims = [
      claim({ claimId: CLAIM_TG, subject: "alpha" }),
      claim({ claimId: CLAIM_DC, subject: "beta" }),
    ]
    const text = renderCorrectionFallback({
      claims,
      results: [invalidated(CLAIM_TG), invalidated(CLAIM_DC)],
      recoveredSource: "x-home-fyp",
      destination: "discord",
    })
    expect(text).toContain("alpha, beta")
  })

  it("does not echo @handles or paths from claim summaries", () => {
    const claims = [claim({ claimId: CLAIM_TG })]
    const tg = renderCorrectionFallback({
      claims,
      results: [invalidated(CLAIM_TG, "no longer stands")],
      recoveredSource: "x-home-fyp",
      destination: "telegram",
    })
    const dc = renderCorrectionFallback({
      claims,
      results: [invalidated(CLAIM_TG, "no longer stands")],
      recoveredSource: "x-home-fyp",
      destination: "discord",
    })
    for (const text of [tg, dc]) {
      expect(text).not.toContain("@evil_handle")
      expect(text).not.toContain("agent/state/secret.json")
    }
  })
})

describe("singleDiscordReplyTarget", () => {
  it("only resolves when exactly one claim has a provider message id", () => {
    expect(singleDiscordReplyTarget({
      claims: [
        claim({ claimId: CLAIM_TG, eventId: EVENT_ID }),
        claim({ claimId: CLAIM_DC, eventId: "sha256:" + "f".repeat(64) }),
      ],
      providerMessageIds: { [EVENT_ID]: "msg-1" },
    })).toBeUndefined()

    expect(singleDiscordReplyTarget({
      claims: [claim({ claimId: CLAIM_TG })],
      providerMessageIds: { [EVENT_ID]: "msg-1" },
    })).toBeUndefined()

    expect(singleDiscordReplyTarget({
      claims: [claim({ claimId: CLAIM_TG, eventId: EVENT_ID })],
      providerMessageIds: { [EVENT_ID]: "msg-99" },
    })).toBe("msg-99")
  })
})

describe("correctionEventId", () => {
  it("is stable and idempotent for same inputs", () => {
    const a = correctionEventId({
      incidentId: "rem-aaaaaaaaaaaa",
      destination: "telegram",
      claimIds: [CLAIM_DC, CLAIM_TG],
    })
    const b = correctionEventId({
      incidentId: "rem-aaaaaaaaaaaa",
      destination: "telegram",
      claimIds: [CLAIM_TG, CLAIM_DC],
    })
    expect(a).toBe(b)
    expect(a.startsWith("sha256:")).toBe(true)
    expect(a).not.toBe(correctionEventId({
      incidentId: "rem-aaaaaaaaaaaa",
      destination: "discord",
      claimIds: [CLAIM_TG, CLAIM_DC],
    }))
  })
})

describe("claimsForDestination", () => {
  it("filters by destination delivery on broadcasts", () => {
    const claims = [
      claim({ claimId: CLAIM_TG, destinations: ["telegram"], subject: "a" }),
      claim({ claimId: CLAIM_DC, destinations: ["discord"], subject: "b" }),
      claim({ claimId: CLAIM_BOTH, destinations: ["telegram", "discord"], subject: "c" }),
    ]
    const invalidatedIds = new Set([CLAIM_TG, CLAIM_DC, CLAIM_BOTH])
    expect(claimsForDestination({
      claims,
      invalidatedIds,
      destination: "telegram",
    }).map((c) => c.claimId).sort()).toEqual([CLAIM_BOTH, CLAIM_TG].sort())
    expect(claimsForDestination({
      claims,
      invalidatedIds,
      destination: "discord",
    }).map((c) => c.claimId).sort()).toEqual([CLAIM_BOTH, CLAIM_DC].sort())
  })

  it("never includes narrative or decision claims", () => {
    const claims: MarketClaimRecord[] = [
      claim({ claimId: CLAIM_TG, destinations: ["telegram"], subject: "sol-memes" }),
      {
        schema: 1,
        claimId: "mc_n_" + "n".repeat(24),
        kind: "narrative-stage",
        runId: "run-1",
        occurredAt: "2026-07-21T02:00:00.000Z",
        subject: "sol-memes",
        summary: "fade",
        narrativeStage: "fading",
        provenanceIds: [],
        refs: [],
        destinations: [],
      },
      {
        schema: 1,
        claimId: "mc_d_" + "d".repeat(24),
        kind: "decision",
        runId: "run-1",
        occurredAt: "2026-07-21T02:00:00.000Z",
        subject: "sol:Token111",
        summary: "track",
        decisionId: "dec-1",
        verdict: "track",
        provenanceIds: [],
        refs: [],
        destinations: [],
      },
    ]
    const invalidatedIds = new Set(claims.map((c) => c.claimId))
    expect(claimsForDestination({
      claims,
      invalidatedIds,
      destination: "telegram",
    }).map((c) => c.claimId)).toEqual([CLAIM_TG])
    expect(claimsForDestination({
      claims: claims.filter((c) => c.kind !== "broadcast"),
      invalidatedIds,
      destination: "telegram",
    })).toEqual([])
  })
})

describe("buildCorrectionPayloads", () => {
  it("builds both channel payloads from fallback", () => {
    const claims = [claim({ claimId: CLAIM_BOTH, destinations: ["telegram", "discord"] })]
    const payloads = buildCorrectionPayloads({
      telegramClaims: claims,
      discordClaims: claims,
      results: [invalidated(CLAIM_BOTH)],
      recoveredSource: "x-home-fyp",
    })
    expect(payloads.telegram.text.length).toBeGreaterThan(10)
    expect(payloads.discord.text.length).toBeGreaterThan(10)
    expect(payloads.discord.text.length).toBeLessThanOrEqual(1_000)
  })
})

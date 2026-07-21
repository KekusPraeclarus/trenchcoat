import { describe, expect, it } from "vitest"
import { parseTrackingMatchOutput } from "../../src/discord/tracking-match.js"
import { sanitizeTrackingReason, renderTrackingFoundHeader } from "../../src/discord/tracking-sanitize.js"
import { validateTokenQueryAgainstCandidate } from "../../src/discord/tracking-token-query.js"
import { parseTrackingMentionReview } from "../../src/discord/tracking-qualify.js"
import { trackingChainAllows } from "../../src/discord/tracking-state.js"
import { TRACKING_MATCH_PROMPT, TRACKING_MENTION_REVIEW_PROMPT } from "../../src/prompts/host.js"

const CANDIDATES = [
  {
    provenance: "twitter:@alpha",
    text: "watching $FOO on robinhood 0x6055706234Dd0CC9965400296f2Ca950941f6253",
  },
]

describe("discord tracking match", () => {
  it("allowlists ids, binds provenance, and validates tokenQuery", () => {
    const hits = parseTrackingMatchOutput(JSON.stringify({
      matches: [
        {
          trackingId: "trk-owner001",
          candidateProvenance: "twitter:@alpha",
          tokenQuery: "$FOO",
          reason: "hit <@1> https://x.com",
        },
        {
          trackingId: "trk-other002",
          candidateProvenance: "twitter:@alpha",
          tokenQuery: "$FOO",
          reason: "no",
        },
        {
          trackingId: "trk-owner001",
          candidateProvenance: "invented",
          tokenQuery: "$FOO",
          reason: "bad provenance",
        },
        {
          trackingId: "trk-owner001",
          candidateProvenance: "twitter:@alpha",
          tokenQuery: "Virtuals",
          reason: "project name only",
        },
      ],
    }), new Set(["trk-owner001"]), CANDIDATES, 10)
    expect(hits).toEqual([{
      trackingId: "trk-owner001",
      candidateProvenance: "twitter:@alpha",
      tokenQuery: "$FOO",
      reason: "hit",
      resolveSubject: "FOO",
    }])
  })

  it("returns empty on malformed output", () => {
    expect(parseTrackingMatchOutput("{}", new Set(["trk-owner001"]), CANDIDATES, 10)).toEqual([])
    expect(parseTrackingMatchOutput('{"matches":"x"}', new Set(["trk-owner001"]), CANDIDATES, 10)).toEqual([])
  })

  it("prompt is path-only and requires provenance+tokenQuery", () => {
    expect(TRACKING_MATCH_PROMPT).toMatch(/path only/iu)
    expect(TRACKING_MATCH_PROMPT).toMatch(/candidateProvenance/u)
    expect(TRACKING_MATCH_PROMPT).toMatch(/tokenQuery/u)
    expect(sanitizeTrackingReason("@everyone buy now")).toBe("buy now")
  })
})

describe("discord tracking token query", () => {
  it("accepts CA and ticker present in candidate", () => {
    expect(validateTokenQueryAgainstCandidate({
      tokenQuery: "0x6055706234Dd0CC9965400296f2Ca950941f6253",
      candidateText: CANDIDATES[0]!.text,
    })?.kind).toBe("contract")
    expect(validateTokenQueryAgainstCandidate({
      tokenQuery: "FOO",
      candidateText: CANDIDATES[0]!.text,
    })?.kind).toBe("ticker")
  })

  it("rejects project-name-only guesses", () => {
    expect(validateTokenQueryAgainstCandidate({
      tokenQuery: "interesting AI project",
      candidateText: CANDIDATES[0]!.text,
    })).toBeUndefined()
    expect(validateTokenQueryAgainstCandidate({
      tokenQuery: "BAR",
      candidateText: CANDIDATES[0]!.text,
    })).toBeUndefined()
  })
})

describe("discord tracking mention review + header", () => {
  it("fails closed on malformed review", () => {
    expect(parseTrackingMentionReview("nope")).toEqual({
      verdict: "reject",
      reason: "malformed-review",
    })
    expect(parseTrackingMentionReview('{"verdict":"approve","reason":"ok"}')).toEqual({
      verdict: "approve",
      reason: "ok",
    })
    expect(TRACKING_MENTION_REVIEW_PROMPT).toMatch(/path only/iu)
  })

  it("renders shortLabel as stored", () => {
    expect(renderTrackingFoundHeader({
      userId: "1000000000000000004",
      shortLabel: "RH AI projects",
    })).toBe("<@1000000000000000004> I found a token matching RH AI projects")
  })

  it("drops robinhood-constrained request against a solana resolve", () => {
    // Host worker uses this after resolveResearchSubject — Solana $AI must not bind RH AI
    expect(trackingChainAllows("robinhood", "solana")).toBe(false)
    expect(trackingChainAllows("robinhood", "robinhood")).toBe(true)
  })
})

import { describe, expect, it } from "vitest"
import { parseTrackingMatchOutput } from "../../src/discord/tracking-match.js"
import { sanitizeTrackingReason } from "../../src/discord/tracking-sanitize.js"
import { TRACKING_MATCH_PROMPT } from "../../src/prompts/host.js"

describe("discord tracking match", () => {
  it("allowlists ids and sanitizes reasons", () => {
    const hits = parseTrackingMatchOutput(JSON.stringify({
      matches: [
        { trackingId: "trk-owner001", subject: "FOO", reason: "hit <@1> https://x.com" },
        { trackingId: "trk-other002", subject: "BAR", reason: "no" },
      ],
    }), new Set(["trk-owner001"]), 10)
    expect(hits).toEqual([{
      trackingId: "trk-owner001",
      subject: "FOO",
      reason: "hit",
    }])
  })

  it("returns empty on malformed output", () => {
    expect(parseTrackingMatchOutput("{}", new Set(["trk-owner001"]), 10)).toEqual([])
    expect(parseTrackingMatchOutput('{"matches":"x"}', new Set(["trk-owner001"]), 10)).toEqual([])
  })

  it("prompt is path-only", () => {
    expect(TRACKING_MATCH_PROMPT).toMatch(/path only/iu)
    expect(sanitizeTrackingReason("@everyone buy now")).toBe("buy now")
  })
})

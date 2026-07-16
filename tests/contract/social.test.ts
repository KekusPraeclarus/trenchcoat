import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseTweetFixture } from "../../src/collectors/social/twitter.js"
import { extractCallEvents } from "../../src/lib/call-events.js"

describe("contract social fixtures", () => {
  it("parses tweet fixtures and isolates injection text as data", () => {
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), "tests/fixtures/tweets.json"), "utf8"),
    ) as { tweets: unknown }
    const tweets = parseTweetFixture(raw.tweets)
    expect(tweets).toHaveLength(2)
    const injected = tweets.find((t) => t.text.includes("ignore previous"))
    expect(injected).toBeTruthy()
    const calls = extractCallEvents({
      sourceId: "attacker",
      provenance: "fixture:2",
      text: injected!.text,
      mentionedAt: injected!.createdAt,
    })
    expect(calls).toHaveLength(0)
  })
})

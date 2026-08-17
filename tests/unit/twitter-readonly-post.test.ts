import { describe, expect, it } from "vitest"
import { isAllowedReadTimelinePost } from "../../src/collectors/twitter/scrape.js"

describe("read-only X timeline POST allowlist", () => {
  it("allows Home and list timeline GraphQL reads", () => {
    expect(isAllowedReadTimelinePost(
      "https://x.com/i/api/graphql/abc/HomeLatestTimeline",
      JSON.stringify({ operationName: "HomeLatestTimeline" }),
    )).toBe(true)
    expect(isAllowedReadTimelinePost(
      "https://api.x.com/graphql/xyz/HomeTimeline",
      JSON.stringify({ operationName: "HomeTimeline" }),
    )).toBe(true)
    expect(isAllowedReadTimelinePost(
      "https://twitter.com/i/api/graphql/def/ListLatestTweetsTimeline",
      JSON.stringify({ operationName: "ListLatestTweetsTimeline" }),
    )).toBe(true)
  })

  it("blocks mutations, missing ops, and non-graphql posts", () => {
    expect(isAllowedReadTimelinePost(
      "https://x.com/i/api/graphql/abc/FavoriteTweet",
      JSON.stringify({ operationName: "FavoriteTweet" }),
    )).toBe(false)
    expect(isAllowedReadTimelinePost(
      "https://x.com/i/api/graphql/abc/CreateTweet",
      JSON.stringify({ operationName: "CreateTweet" }),
    )).toBe(false)
    expect(isAllowedReadTimelinePost(
      "https://x.com/i/api/graphql",
      null,
    )).toBe(false)
    expect(isAllowedReadTimelinePost(
      "https://x.com/i/api/1.1/statuses/home_timeline.json",
      JSON.stringify({ operationName: "HomeTimeline" }),
    )).toBe(false)
  })
})

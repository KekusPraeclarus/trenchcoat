import { describe, expect, it } from "vitest"
import { classifyFomoRequest, isFomoFeedCaptureUrl, isFomoProfileUserHandleUrl } from "../../src/collectors/fomo/request-policy.js"

describe("fomo request policy", () => {
  it("allows read traffic on fomo and privy", () => {
    expect(classifyFomoRequest("GET", "https://fomo.family/").allow).toBe(true)
    expect(classifyFomoRequest("HEAD", "https://www.fomo.family/app").allow).toBe(true)
    expect(classifyFomoRequest("GET", "https://prod-api.fomo.family/v1/feed").allow).toBe(true)
    expect(classifyFomoRequest("POST", "https://auth.privy.io/api/v1/sessions").allow).toBe(true)
  })

  it("blocks analytics, rpc, and unallowlisted posts", () => {
    expect(classifyFomoRequest("GET", "https://www.google-analytics.com/g/collect").allow).toBe(false)
    expect(classifyFomoRequest("GET", "https://mainnet.helius-rpc.com/").allow).toBe(false)
    expect(classifyFomoRequest("POST", "https://prod-api.fomo.family/v1/orders").allow).toBe(false)
    expect(classifyFomoRequest("PUT", "https://fomo.family/settings").allow).toBe(false)
  })

  it("rejects invalid urls", () => {
    expect(classifyFomoRequest("GET", "not-a-url").allow).toBe(false)
  })

  it("captures live /feed/token and keeps the old tradingActivity path", () => {
    expect(isFomoFeedCaptureUrl("https://prod-api.fomo.family/feed/token")).toBe(true)
    expect(isFomoFeedCaptureUrl("https://prod-api.fomo.family/feed/token?page=1")).toBe(true)
    expect(isFomoFeedCaptureUrl("https://prod-api.fomo.family/feed/tradingActivity")).toBe(true)
    expect(isFomoFeedCaptureUrl("https://prod-api.fomo.family/feed/token/thesis")).toBe(false)
    expect(isFomoFeedCaptureUrl("https://prod-api.fomo.family/v2/leaderboard/7d")).toBe(false)
  })

  it("captures /v2/users/userHandle/{handle} and skips session /v2/users", () => {
    expect(isFomoProfileUserHandleUrl("https://prod-api.fomo.family/v2/users/userHandle/ether_monk", "ether_monk")).toBe(true)
    expect(isFomoProfileUserHandleUrl("https://prod-api.fomo.family/v2/users/userHandle/ether_monk?x=1", "ether_monk")).toBe(true)
    expect(isFomoProfileUserHandleUrl("https://prod-api.fomo.family/v2/users", "ether_monk")).toBe(false)
    expect(isFomoProfileUserHandleUrl("https://prod-api.fomo.family/v2/users/userHandle/other", "ether_monk")).toBe(false)
    expect(isFomoProfileUserHandleUrl("https://prod-api.fomo.family/v2/users/abc/swaps", "ether_monk")).toBe(false)
  })

  it("allows follow mutations only in mutationMode", () => {
    const follow = "https://prod-api.fomo.family/v2/follow"
    expect(classifyFomoRequest("POST", follow).allow).toBe(false)
    expect(classifyFomoRequest("POST", follow, { mutationMode: true }).allow).toBe(true)
    expect(classifyFomoRequest("POST", "https://prod-api.fomo.family/v1/orders", {
      mutationMode: true,
    }).allow).toBe(false)
    expect(classifyFomoRequest("PUT", "https://prod-api.fomo.family/v2/unfollow", {
      mutationMode: true,
    }).allow).toBe(true)
    expect(classifyFomoRequest(
      "POST",
      "https://prod-api.fomo.family/v2/users/aefe2ddd-c580-5245-a2f5-e4ed62f7ef10/follow",
      { mutationMode: true },
    ).allow).toBe(true)
    expect(classifyFomoRequest(
      "POST",
      "https://prod-api.fomo.family/v2/users/aefe2ddd-c580-5245-a2f5-e4ed62f7ef10/following",
      { mutationMode: true },
    ).allow).toBe(true)
    expect(classifyFomoRequest(
      "POST",
      "https://featureassets.org/v1/initialize",
      { mutationMode: true, allowedPosts: [{ host: "featureassets.org", path: "/v1/initialize" }] },
    ).allow).toBe(true)
    expect(classifyFomoRequest("POST", "https://featureassets.org/v1/initialize").allow).toBe(false)
  })
})

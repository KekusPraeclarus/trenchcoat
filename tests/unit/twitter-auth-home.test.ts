import { describe, expect, it } from "vitest"
import {
  isTwitterAuthBlockedUrl,
  twitterAuthHomeReady,
} from "../../src/collectors/social/twitter-auth.js"

describe("twitter auth home gate", () => {
  it("blocks login, account access, and challenge URLs", () => {
    expect(isTwitterAuthBlockedUrl("https://x.com/i/flow/login")).toBe(true)
    expect(isTwitterAuthBlockedUrl("https://x.com/account/access")).toBe(true)
    expect(isTwitterAuthBlockedUrl("https://x.com/account/access?lang=en")).toBe(true)
    expect(isTwitterAuthBlockedUrl("https://twitter.com/i/flow/login")).toBe(true)
    expect(isTwitterAuthBlockedUrl("https://x.com/home")).toBe(false)
  })

  it("requires home UI on a home URL", () => {
    expect(twitterAuthHomeReady({ url: "https://x.com/home", homeUiCount: 2 })).toBe(true)
    expect(twitterAuthHomeReady({ url: "https://x.com/home?locale=en", homeUiCount: 1 })).toBe(true)
    expect(twitterAuthHomeReady({ url: "https://twitter.com/home", homeUiCount: 1 })).toBe(true)
  })

  it("rejects a cookie-only session on access or login pages", () => {
    expect(twitterAuthHomeReady({ url: "https://x.com/account/access", homeUiCount: 0 })).toBe(false)
    expect(twitterAuthHomeReady({ url: "https://x.com/i/flow/login", homeUiCount: 3 })).toBe(false)
    expect(twitterAuthHomeReady({ url: "https://x.com/home", homeUiCount: 0 })).toBe(false)
    expect(twitterAuthHomeReady({ url: "about:blank", homeUiCount: 0 })).toBe(false)
  })
})

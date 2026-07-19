import { describe, expect, it } from "vitest"
import { classifyFomoRequest } from "../../src/collectors/fomo/request-policy.js"

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
})

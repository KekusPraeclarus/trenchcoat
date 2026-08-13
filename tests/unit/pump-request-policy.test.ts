import { describe, expect, it } from "vitest"
import { classifyPumpDiscoverObserve, classifyPumpRequest } from "../../src/collectors/pump/request-policy.js"

describe("pump request policy", () => {
  it("allows read traffic on pump.fun and privy", () => {
    expect(classifyPumpRequest("GET", "https://pump.fun/").allow).toBe(true)
    expect(classifyPumpRequest("HEAD", "https://www.pump.fun/explore").allow).toBe(true)
    expect(classifyPumpRequest("GET", "https://frontend-api-v3.pump.fun/coins").allow).toBe(true)
    expect(classifyPumpRequest("POST", "https://auth.privy.io/api/v1/sessions").allow).toBe(true)
    expect(classifyPumpRequest(
      "POST",
      "https://frontend-api-v3.pump.fun/coins-v2/mints",
    ).allow).toBe(true)
    expect(classifyPumpRequest(
      "POST",
      "https://pump.fun/cdn-cgi/challenge-platform/h/g/jsd/oneshot/x",
    ).allow).toBe(true)
  })

  it("blocks analytics, rpc, swap, register, and unallowlisted posts", () => {
    expect(classifyPumpRequest("GET", "https://www.google-analytics.com/g/collect").allow).toBe(false)
    expect(classifyPumpRequest("GET", "https://mainnet.helius-rpc.com/").allow).toBe(false)
    expect(classifyPumpRequest("GET", "https://solana-mainnet.pump.fun/abc").allow).toBe(false)
    expect(classifyPumpRequest("POST", "https://pump.fun/api/swap").allow).toBe(false)
    expect(classifyPumpRequest("POST", "https://pump.fun/api/dm").allow).toBe(false)
    expect(classifyPumpRequest("POST", "https://frontend-api-v3.pump.fun/users/register").allow).toBe(false)
    expect(classifyPumpRequest("PUT", "https://pump.fun/settings").allow).toBe(false)
  })

  it("lets discover observe feed POSTs but not likes or register", () => {
    expect(classifyPumpDiscoverObserve(
      "POST",
      "https://frontend-api-v3.pump.fun/coins/for-you",
    ).allow).toBe(true)
    expect(classifyPumpDiscoverObserve("POST", "https://pump.fun/api/like").allow).toBe(false)
    expect(classifyPumpDiscoverObserve("POST", "https://pump.fun/api/swap").allow).toBe(false)
    expect(classifyPumpDiscoverObserve(
      "POST",
      "https://frontend-api-v3.pump.fun/users/register",
    ).allow).toBe(false)
    expect(classifyPumpDiscoverObserve(
      "POST",
      "https://solana-mainnet.pump.fun/f15623a5-2536-4b47-9641-8abc239413ba",
    ).allow).toBe(false)
  })

  it("allows like and follow posts only in mutation mode", () => {
    expect(classifyPumpRequest("POST", "https://pump.fun/api/follow").allow).toBe(false)
    expect(classifyPumpRequest("POST", "https://pump.fun/api/follow", { mutationMode: true }).allow).toBe(true)
    expect(classifyPumpRequest("POST", "https://pump.fun/api/like", { mutationMode: true }).allow).toBe(true)
    expect(classifyPumpRequest("POST", "https://pump.fun/api/swap", { mutationMode: true }).allow).toBe(false)
  })

  it("rejects invalid urls", () => {
    expect(classifyPumpRequest("GET", "not-a-url").allow).toBe(false)
  })
})

import { describe, expect, it, beforeEach } from "vitest"
import { gatedFetch, gatedFetchWithRetry, readJsonBody } from "../../src/lib/http.js"
import { RateGate, getRateGate, resetRateGatesForTests } from "../../src/lib/rate-gate.js"
import type { FetchLike } from "../../src/collectors/market/geckoterminal.js"

describe("gatedFetchWithRetry", () => {
  beforeEach(() => {
    resetRateGatesForTests()
  })

  const noSleep = async () => undefined

  it("retries a 429 then returns the success response", async () => {
    let calls = 0
    const fetcher: FetchLike = async () => {
      calls += 1
      return calls === 1
        ? new Response("rate limited", { status: 429, headers: { "retry-after": "0.01" } })
        : new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    }
    const response = await gatedFetchWithRetry(fetcher, "https://ex.test/a", {
      host: "ex.test-retry-429",
      capacity: 10,
      refillPerSecond: 100,
      sleep: noSleep,
    })
    expect(response.status).toBe(200)
    expect(calls).toBe(2)
  })

  it("stops after maxAttempts on repeated 500", async () => {
    let calls = 0
    const fetcher: FetchLike = async () => {
      calls += 1
      return new Response("boom", { status: 500 })
    }
    const response = await gatedFetchWithRetry(fetcher, "https://ex.test/b", {
      host: "ex.test-retry-500",
      capacity: 10,
      refillPerSecond: 100,
      maxAttempts: 3,
      sleep: noSleep,
    })
    expect(response.status).toBe(500)
    expect(calls).toBe(3)
  })

  it("never retries an ordinary 400", async () => {
    let calls = 0
    const fetcher: FetchLike = async () => {
      calls += 1
      return new Response("bad", { status: 400 })
    }
    const response = await gatedFetchWithRetry(fetcher, "https://ex.test/c", {
      host: "ex.test-retry-400",
      capacity: 10,
      refillPerSecond: 100,
      sleep: noSleep,
    })
    expect(response.status).toBe(400)
    expect(calls).toBe(1)
  })

  it("never retries a monthly-budget exhaustion", async () => {
    let calls = 0
    const fetcher: FetchLike = async () => {
      calls += 1
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    }
    await expect(gatedFetchWithRetry(fetcher, "https://ex.test/d", {
      host: "ex.test-retry-budget",
      capacity: 1,
      refillPerSecond: 100,
      monthlyBudget: 0,
      sleep: noSleep,
    })).rejects.toThrow(/Monthly budget exhausted/u)
    expect(calls).toBe(0)
  })
})

describe("prop_inv_r3_observe429", () => {
  beforeEach(() => {
    resetRateGatesForTests()
  })

  it("zeros tokens and honours Retry-After before refill", async () => {
    const gate = new RateGate("example.test", {
      capacity: 5,
      refillPerSecond: 100,
    })
    await gate.take(2)
    expect(gate.snapshot().tokens).toBe(3)

    gate.observe429(0.05)
    expect(gate.snapshot().tokens).toBe(0)

    const start = Date.now()
    await gate.take(1)
    expect(Date.now() - start).toBeGreaterThanOrEqual(40)
  })

  it("gatedFetch records Retry-After from HTTP 429 onto the shared host gate", async () => {
    const fetcher: FetchLike = async () => new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "0.05" },
    })
    const host = "example.test-429"
    const response = await gatedFetch(fetcher, "https://example.test/x", {
      host,
      capacity: 2,
      refillPerSecond: 100,
    })
    expect(response.status).toBe(429)

    const gate = getRateGate(host, { capacity: 2, refillPerSecond: 100 })
    expect(gate.snapshot().tokens).toBe(0)

    const start = Date.now()
    await gate.take(1)
    expect(Date.now() - start).toBeGreaterThanOrEqual(40)
  })
})

function hangingJson(): Response {
  const body = new ReadableStream<Uint8Array>({
    start() {
      // stalled body
    },
  })
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

describe("response body timeout", () => {
  beforeEach(() => {
    resetRateGatesForTests()
  })

  it("parses a finished JSON body", async () => {
    const body = await readJsonBody(new Response("{\"ok\":true}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }))
    expect(body).toEqual({ ok: true })
  })

  it("aborts a stalled body read", async () => {
    await expect(readJsonBody(hangingJson(), 1024, 40)).rejects.toThrow(/timed out/u)
  })

  it("aborts a stalled body returned by gatedFetch", async () => {
    const fetcher: FetchLike = async () => hangingJson()
    const response = await gatedFetch(fetcher, "https://ex.test/hang", {
      host: "ex.test-body-timeout",
      capacity: 5,
      refillPerSecond: 100,
      timeoutMs: 40,
    })
    await expect(response.text()).rejects.toThrow(/timed out/u)
  })
})

import { describe, expect, it, beforeEach } from "vitest"
import { RateGate, getRateGate, resetRateGatesForTests } from "../../src/lib/rate-gate.js"
import {
  INFURA_MIN_INTERVAL_MS,
  INFURA_CORE_CREDITS_PER_SECOND,
  INFURA_ETH_GET_LOGS_CREDITS,
  INFURA_THROUGHPUT_BUDGET_CREDITS_PER_SECOND,
  infuraCreditCost,
} from "../../src/collectors/wallets/infura.js"

describe("RateGate serial minInterval", () => {
  beforeEach(() => {
    resetRateGatesForTests()
  })

  it("forces a pause between sequential takes", async () => {
    const gate = new RateGate("example.min-interval", {
      capacity: 10,
      refillPerSecond: 100,
      minIntervalMs: 40,
    })
    const t0 = Date.now()
    await gate.take()
    await gate.take()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35)
  })

  it("serializes concurrent takes so spacing still holds", async () => {
    const gate = new RateGate("example.min-interval-concurrent", {
      capacity: 10,
      refillPerSecond: 100,
      minIntervalMs: 30,
    })
    const started = Date.now()
    await Promise.all([gate.take(), gate.take(), gate.take()])
    // three takes → at least two gaps
    expect(Date.now() - started).toBeGreaterThanOrEqual(55)
    expect(gate.snapshot().tokens).toBeGreaterThanOrEqual(0)
  })

  it("getRateGate shares one mutex per host", async () => {
    const a = getRateGate("shared.host", { capacity: 5, refillPerSecond: 50, minIntervalMs: 25 })
    const b = getRateGate("shared.host", { capacity: 5, refillPerSecond: 50, minIntervalMs: 25 })
    expect(a).toBe(b)
    const started = Date.now()
    await Promise.all([a.take(), b.take()])
    expect(Date.now() - started).toBeGreaterThanOrEqual(20)
  })
})

describe("Infura throughput budget", () => {
  it("sizes min interval under Core credits/sec using eth_getLogs cost", () => {
    expect(INFURA_CORE_CREDITS_PER_SECOND).toBe(500)
    expect(INFURA_ETH_GET_LOGS_CREDITS).toBe(255)
    expect(INFURA_THROUGHPUT_BUDGET_CREDITS_PER_SECOND).toBe(400)
    expect(INFURA_MIN_INTERVAL_MS).toBe(
      Math.ceil((255 / 400) * 1_000),
    )
    expect(INFURA_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(600)
    expect(infuraCreditCost("eth_getLogs")).toBe(255)
    expect(infuraCreditCost("eth_getBlockByNumber")).toBe(80)
    expect(infuraCreditCost("unknown_method")).toBe(255)
  })
})

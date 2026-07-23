import { describe, expect, it } from "vitest"
import { deriveDiscordWalletSignals } from "../../src/collectors/discord-wallet/derive.js"
import type { TxEvent } from "../../src/collectors/discord-wallet/types.js"

const CA = "EN2nnxrg8uUi6x2sJkzNPd2eT6rB9rdSoQNNaENA4RZA"
const NOW = "2026-07-23T12:00:00.000Z"

function buy(actor: string, minutesAgo: number, extras?: Partial<TxEvent>): TxEvent {
  return {
    parser: "cielo_swap",
    messageId: `${actor}-${minutesAgo}`,
    channelId: "1",
    receivedAt: new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString(),
    actor,
    chain: "solana",
    side: "buy",
    tokenContract: CA,
    confidence: "high",
    ...extras,
  }
}

function sell(actor: string, minutesAgo: number): TxEvent {
  return {
    ...buy(actor, minutesAgo),
    side: "sell",
    messageId: `sell-${actor}-${minutesAgo}`,
  }
}

describe("discord-wallet derive", () => {
  const defaults = {
    observedAt: NOW,
    actorDedupeTtlMinutes: 15,
    convergence: { enabled: true, windowMinutes: 60, minActors: 3 },
    sellPressure: { enabled: true, windowMinutes: 60, minActors: 3 },
  }

  it("emits buy confluence at min actors", () => {
    const signals = deriveDiscordWalletSignals({
      ...defaults,
      events: [buy("a", 10), buy("b", 8), buy("c", 5)],
    })
    expect(signals).toHaveLength(1)
    expect(signals[0]?.kind).toBe("convergence")
    expect(signals[0]?.polarity).toBe("bullish")
    expect(signals[0]?.tokenContract).toBe(CA)
    expect(signals[0]?.actors).toHaveLength(3)
  })

  it("emits sell pressure without enqueue fields", () => {
    const signals = deriveDiscordWalletSignals({
      ...defaults,
      events: [sell("a", 10), sell("b", 8), sell("c", 5)],
    })
    expect(signals).toHaveLength(1)
    expect(signals[0]?.kind).toBe("sell-pressure")
    expect(signals[0]?.polarity).toBe("bearish")
    expect(Object.keys(signals[0]!)).not.toContain("enqueue")
  })

  it("empty window never emits bearish", () => {
    expect(deriveDiscordWalletSignals({ ...defaults, events: [] })).toEqual([])
  })

  it("excludes human_lossy low confidence from confluence", () => {
    const signals = deriveDiscordWalletSignals({
      ...defaults,
      events: [
        buy("a", 10),
        buy("b", 8),
        buy("c", 5, { parser: "human_lossy", confidence: "low" }),
      ],
    })
    expect(signals).toEqual([])
  })

  it("dedupes same actor+CA+side within TTL", () => {
    const signals = deriveDiscordWalletSignals({
      ...defaults,
      events: [buy("a", 10), buy("a", 5), buy("b", 8), buy("c", 3)],
    })
    expect(signals).toHaveLength(1)
    expect(signals[0]?.actors).toHaveLength(3)
  })

  it("excludes transfers from confluence", () => {
    const signals = deriveDiscordWalletSignals({
      ...defaults,
      events: [
        buy("a", 10),
        buy("b", 8),
        {
          ...buy("c", 5),
          side: "transfer",
          parser: "cielo_transfer",
        },
      ],
    })
    expect(signals).toEqual([])
  })
})

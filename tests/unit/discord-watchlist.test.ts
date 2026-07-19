import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discordLayout } from "../../src/discord/paths.js"
import { createDiscordStore, emptyRequestsFile } from "../../src/discord/store.js"
import { subscribeAfterResearch } from "../../src/discord/watchlist.js"
import { emptyWatchlistFile } from "../../src/discord/store.js"

describe("discord watchlist", () => {
  it("creates subscription after research", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-discord-"))
    try {
      const layout = discordLayout(root)
      const result = subscribeAfterResearch({
        file: emptyWatchlistFile(),
        identity: {
          chain: "solana",
          tokenAddress: "CREDBH1234567890123456789012345678901234",
          pairAddress: "pair",
          symbolDisplay: "CRED",
          resolution: "resolved",
        },
        guildId: "1",
        userId: "2",
        channelId: "3",
        messageId: "4",
        nowIso: "2026-07-19T12:00:00.000Z",
        baseline: {
          observedAt: "2026-07-19T12:00:00.000Z",
          priceUsd: 1,
          liquidityUsd: 1,
          volume24hUsd: 1,
          fdvUsd: 1,
          buys24h: 1,
          sells24h: 1,
          securityStatus: "pass",
          securityFlags: [],
          xPostCount: 0,
          xAuthorCount: 0,
          xRecentCount: 0,
          xKnownLikes: null,
          xKnownViews: null,
          xKnownReplies: null,
          xKnownReposts: null,
          xAuthorIds: [],
        },
      })
      expect(result.subscribed).toBe(true)
      expect(result.file.tokens).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("stores researchBrief on subscribe", () => {
    const result = subscribeAfterResearch({
      file: emptyWatchlistFile(),
      identity: {
        chain: "solana",
        tokenAddress: "CREDBH1234567890123456789012345678901234",
        pairAddress: "pair",
        symbolDisplay: "CRED",
        resolution: "resolved",
      },
      guildId: "1",
      userId: "2",
      channelId: "3",
      messageId: "4",
      nowIso: "2026-07-19T12:00:00.000Z",
      baseline: {
        observedAt: "2026-07-19T12:00:00.000Z",
        priceUsd: 1,
        liquidityUsd: 1,
        volume24hUsd: 1,
        fdvUsd: 1,
        buys24h: 1,
        sells24h: 1,
        securityStatus: "pass",
        securityFlags: [],
        xPostCount: 0,
        xAuthorCount: 0,
        xRecentCount: 0,
        xKnownLikes: null,
        xKnownViews: null,
        xKnownReplies: null,
        xKnownReposts: null,
        xAuthorIds: [],
      },
      researchBrief: "Meme rotation with thin liq.",
    })
    expect(result.file.tokens[0]?.researchBrief).toBe("Meme rotation with thin liq.")
  })

  it("persists requests atomically", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-discord-"))
    try {
      const layout = discordLayout(root)
      const store = createDiscordStore(layout)
      const file = emptyRequestsFile("2026-07-19T12:00:00.000Z")
      await store.saveRequests(file)
      expect(store.loadRequests().schema).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

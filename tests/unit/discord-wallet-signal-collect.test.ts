import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { ConfigSchema } from "../../src/lib/config.js"
import { migrateConfigToV29 } from "../../src/migrations/config.js"
import { collectDiscordWalletSignalScan } from "../../src/orchestrator/discord-wallet-signal-collect.js"
import type { DiscordHistoryMessage, DiscordRestClient } from "../../src/discord/bot-client.js"
import { COLOR_BUY } from "../../src/collectors/discord-wallet/types.js"
import { readFileSync as readSeed } from "node:fs"

const seed = JSON.parse(
  readSeed(join(process.cwd(), "config/seed.example.json"), "utf8"),
) as Record<string, unknown>

function baseConfig(overrides?: Record<string, unknown>) {
  const raw = structuredClone(seed) as Record<string, unknown>
  const chat = raw["chat"] as Record<string, unknown>
  const discord = chat["discord"] as Record<string, unknown>
  discord["wallet_signals"] = {
    enabled: true,
    shadow_mode: true,
    channel_ids: ["1000000000000000003"],
    scan_interval_minutes: 5,
    max_message_age_hours: 6,
    actor_dedupe_ttl_minutes: 15,
    convergence: { enabled: true, window_minutes: 60, min_actors: 3 },
    sell_pressure: { enabled: true, window_minutes: 60, min_actors: 3 },
    max_enqueues_per_day: 3,
    ...overrides,
  }
  return ConfigSchema.parse(migrateConfigToV29(raw))
}

function buyMessage(args: Readonly<{
  id: string
  actor: string
  token: string
  minutesAgo: number
  now: string
}>): DiscordHistoryMessage {
  const ts = new Date(Date.parse(args.now) - args.minutesAgo * 60_000).toISOString()
  return {
    id: args.id,
    channelId: "1000000000000000003",
    authorId: "999999999999999999",
    authorIsBot: false,
    authorIsWebhook: true,
    content: "",
    timestamp: ts,
    embeds: [{
      color: COLOR_BUY,
      description: [
        `#${args.actor}`,
        `Swapped 10 USDT ($10) for 100 TOKEN On OKX`,
        `Token: ${args.token}`,
        "solana | ViewTx",
      ].join("\n"),
    }],
  }
}

describe("discord-wallet-signal-collect", () => {
  it("advances cursor, writes inbox, and blocks enqueue in shadow_mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-dws-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    const cursorPath = join(root, "wallet-signal-cursors.json")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    mkdirSync(archiveRoot, { recursive: true })
    const writer = new SnapshotWriter(agentRoot)
    const now = "2026-07-23T12:00:00.000Z"
    const token = "EN2nnxrg8uUi6x2sJkzNPd2eT6rB9rdSoQNNaENA4RZA"
    const messages = [
      buyMessage({ id: "100", actor: "a", token, minutesAgo: 10, now }),
      buyMessage({ id: "101", actor: "b", token, minutesAgo: 8, now }),
      buyMessage({ id: "102", actor: "c", token, minutesAgo: 5, now }),
    ]
    const client: DiscordRestClient = {
      async sendReply() {
        return { messageId: "0" }
      },
      async sendChannelMessage() {
        return { messageId: "0" }
      },
      async addReaction() {},
      async listChannelMessages() {
        return messages
      },
      async getBotUserId() {
        return "111111111111111111"
      },
    }

    const summary = await collectDiscordWalletSignalScan({
      runId: "run1",
      writer,
      fetchedAt: now,
      agentRoot,
      archiveRoot,
      client,
      botUserId: "111111111111111111",
      config: baseConfig({ shadow_mode: true }),
      cursorPath,
    })

    expect(summary.skipAgent).toBe(true)
    expect(summary.collectionStatus).toContain("discord-wallet-shadow")
    expect(existsSync(cursorPath)).toBe(true)
    const cursors = JSON.parse(readFileSync(cursorPath, "utf8")) as {
      channels: Record<string, { lastMessageId: string }>
    }
    expect(cursors.channels["1000000000000000003"]?.lastMessageId).toBe("102")

    const inbox = JSON.parse(
      readFileSync(join(agentRoot, "inbox", "run1", "discord-wallet-signals.json"), "utf8"),
    ) as { items: Array<{ text: string }> }
    expect(inbox.items[0]?.text).toContain("kind=convergence")
    expect(inbox.items[0]?.text).toContain("polarity=bullish")

    const queuePath = join(agentRoot, "state", "research-queue.json")
    expect(existsSync(queuePath)).toBe(false)
  })

  it("returns skip when disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-dws-off-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    const writer = new SnapshotWriter(agentRoot)
    const config = baseConfig({ enabled: false })
    const summary = await collectDiscordWalletSignalScan({
      runId: "run2",
      writer,
      fetchedAt: "2026-07-23T12:00:00.000Z",
      agentRoot,
      archiveRoot,
      config,
      client: {
        async sendReply() {
          return { messageId: "0" }
        },
        async sendChannelMessage() {
          return { messageId: "0" }
        },
        async addReaction() {},
      },
    })
    expect(summary.collectionStatus).toBe("wallet-signals-disabled")
  })
})

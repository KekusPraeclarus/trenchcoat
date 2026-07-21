import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discordLayout } from "../../src/discord/paths.js"
import { createDiscordStore, emptyTrackingFile } from "../../src/discord/store.js"
import { deliverTrackingPing } from "../../src/discord/tracking-delivery.js"
import { createOrGetDelivery } from "../../src/discord/tracking-state.js"
import type { DiscordRestClient } from "../../src/discord/bot-client.js"

vi.mock("../../src/lib/config.js", () => ({
  loadConfig: () => ({
    chat: {
      discord: {
        enabled: true,
        tracking: {
          enabled: true,
          intent_model: "composer-2.5",
          match_model: "composer-2.5",
          max_active_per_user: 10,
          ttl_days: 30,
          expiry_bundle_hours: 48,
          pending_capacity_ttl_hours: 48,
          tentative_confirm_window_hours: 24,
          expiry_reply_window_days: 7,
          match_max_attempts: 5,
          match_stale_running_ms: 900_000,
          retention_days: 35,
        },
      },
    },
  }),
}))

describe("crash discord tracking", () => {
  it("does not resend after ambiguous sending state", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-trk-crash-"))
    const prevHome = process.env["HOME"]
    process.env["HOME"] = home
    try {
      const layout = discordLayout(join(home, ".trenchcoat"))
      const store = createDiscordStore(layout)
      const nowIso = "2026-07-21T12:00:00.000Z"
      const request = {
        trackingId: "trk-abcdef12",
        guildId: "1000000000000000001",
        channelId: "1000000000000000002",
        messageId: "1000000000000000003",
        userId: "1000000000000000004",
        description: "privacy",
        shortLabel: "Privacy",
        status: "active" as const,
        createdAt: nowIso,
        updatedAt: nowIso,
        expiresAt: "2026-08-20T12:00:00.000Z",
        extensionCount: 0,
        matchedSubjects: [],
      }
      const created = createOrGetDelivery({
        file: { ...emptyTrackingFile(), requests: [request] },
        trackingId: request.trackingId,
        subject: "MIX",
        reason: "hit",
        batchId: "a".repeat(32),
        sourceKind: "list-scan",
        nowIso,
        request,
        needsResearch: false,
      })
      // Simulate crash after marking sending
      const crashed = {
        ...created.file,
        trackingDeliveries: created.file.trackingDeliveries.map((d) => ({
          ...d,
          status: "sending" as const,
          attemptCount: 1,
        })),
      }
      await store.saveTracking(crashed)

      let sends = 0
      const client: DiscordRestClient = {
        sendReply: async () => {
          sends += 1
          return { messageId: "9000000000000000001" }
        },
        sendChannelMessage: async () => {
          sends += 1
          return { messageId: "9000000000000000002" }
        },
        addReaction: async () => undefined,
      }

      const result = await deliverTrackingPing({
        client,
        store,
        delivery: crashed.trackingDeliveries[0]!,
        nowIso,
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected failure")
      expect(result.ambiguous).toBe(true)
      expect(sends).toBe(0)
      expect(store.loadTracking().trackingDeliveries[0]!.status).toBe("terminal")
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})

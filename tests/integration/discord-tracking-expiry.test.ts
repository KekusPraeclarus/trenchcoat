import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discordLayout } from "../../src/discord/paths.js"
import { createDiscordStore, emptyTrackingFile } from "../../src/discord/store.js"
import { runTrackingExpirySweep } from "../../src/discord/tracking-expiry.js"
import { applyTrackAction, type TrackingConfigSlice } from "../../src/discord/tracking-state.js"
import { addHoursIso } from "../../src/discord/tracking-ids.js"
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

const CFG: TrackingConfigSlice = {
  max_active_per_user: 10,
  ttl_days: 30,
  expiry_bundle_hours: 48,
  pending_capacity_ttl_hours: 48,
  tentative_confirm_window_hours: 24,
  expiry_reply_window_days: 7,
  retention_days: 35,
}

describe("discord tracking expiry integration", () => {
  it("sends one bundled notice and does not duplicate on resweep", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-trk-exp-"))
    const prevHome = process.env["HOME"]
    process.env["HOME"] = home
    try {
      const layout = discordLayout(join(home, ".trenchcoat"))
      const store = createDiscordStore(layout)
      const nowIso = "2026-07-21T12:00:00.000Z"
      let file = emptyTrackingFile()
      const a = applyTrackAction({
        file,
        guildId: "1000000000000000001",
        channelId: "1000000000000000002",
        messageId: "1000000000000000003",
        userId: "1000000000000000004",
        description: "privacy",
        shortLabel: "Privacy on RH",
        confidence: "high",
        nowIso,
        config: CFG,
      })
      if (!a.ok) throw new Error("a")
      file = a.file
      const b = applyTrackAction({
        file,
        guildId: "1000000000000000001",
        channelId: "1000000000000000002",
        messageId: "1000000000000000005",
        userId: "1000000000000000004",
        description: "ai",
        shortLabel: "Solana AI",
        confidence: "high",
        nowIso,
        config: CFG,
      })
      if (!b.ok) throw new Error("b")
      file = {
        ...b.file,
        requests: b.file.requests.map((r) => (
          r.shortLabel === "Privacy on RH"
            ? { ...r, expiresAt: addHoursIso(nowIso, -1) }
            : { ...r, expiresAt: addHoursIso(nowIso, 24) }
        )),
      }
      await store.saveTracking(file)

      const messages: string[] = []
      const client: DiscordRestClient = {
        sendReply: async () => ({ messageId: "1" }),
        sendChannelMessage: async ({ content }) => {
          messages.push(content)
          return { messageId: "2000000000000000099" }
        },
        addReaction: async () => undefined,
      }

      const first = await runTrackingExpirySweep({
        token: "t",
        client,
        store,
        nowIso,
      })
      const second = await runTrackingExpirySweep({
        token: "t",
        client,
        store,
        nowIso,
      })
      expect(first).toBe(1)
      expect(second).toBe(0)
      expect(messages).toHaveLength(1)
      expect(messages[0]).toContain("Privacy on RH")
      expect(messages[0]).toContain("Solana AI")
      const loaded = store.loadTracking()
      expect(loaded.requests.every((r) => r.expiryNoticeMessageId === "2000000000000000099")).toBe(true)
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})

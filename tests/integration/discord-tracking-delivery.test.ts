import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discordLayout } from "../../src/discord/paths.js"
import { createDiscordStore, emptyTrackingFile } from "../../src/discord/store.js"
import { enqueueTrackingMatchBatch, hashTrackingCandidates } from "../../src/discord/tracking-hooks.js"
import { deliverTrackingAlert } from "../../src/discord/tracking-delivery.js"
import type { DiscordRestClient } from "../../src/discord/bot-client.js"
import { createOrGetDelivery } from "../../src/discord/tracking-state.js"
import { renderTrackingFoundHeader } from "../../src/discord/tracking-sanitize.js"
import { trackingDeliveryIdFromIdentity } from "../../src/discord/tracking-ids.js"

vi.mock("../../src/lib/config.js", () => ({
  loadConfig: () => ({
    chat: {
      discord: {
        enabled: true,
        tracking: {
          enabled: true,
          intent_model: "composer-2.5",
          match_model: "composer-2.5",
          mention_review_model: "composer-2.5-fast",
          max_active_per_user: 10,
          ttl_days: 30,
          expiry_bundle_hours: 48,
          pending_capacity_ttl_hours: 48,
          tentative_confirm_window_hours: 24,
          expiry_reply_window_days: 7,
          match_max_attempts: 5,
          match_stale_running_ms: 900_000,
          retention_days: 35,
          mention_review_blacklist_days: 7,
        },
      },
    },
  }),
}))

describe("discord tracking delivery + hooks", () => {
  it("enqueues durable batches idempotently", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-trk-hook-"))
    const prevHome = process.env["HOME"]
    process.env["HOME"] = home
    try {
      const digest = JSON.stringify([{ provenance: "x:1", text: "privacy mixer $MIX" }])
      const hash = hashTrackingCandidates(digest)
      const first = await enqueueTrackingMatchBatch({
        sourceKind: "list-scan",
        runId: "list-scan-1",
        snapshotHash: hash,
        candidateDigest: digest,
        kick: false,
      })
      const second = await enqueueTrackingMatchBatch({
        sourceKind: "list-scan",
        runId: "list-scan-1",
        snapshotHash: hash,
        candidateDigest: digest,
        kick: false,
      })
      expect(first.enqueued).toBe(true)
      expect(second.duplicate).toBe(true)
      const store = createDiscordStore(discordLayout(join(home, ".trenchcoat")))
      expect(store.loadTracking().matchBatches).toHaveLength(1)
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("delivers qualified alert as non-reply channel messages with shortLabel", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-trk-del-"))
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
        shortLabel: "RH AI projects",
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
        subject: "base:0x6055706234dd0cc9965400296f2ca950941f6253",
        reason: "new privacy mixer",
        batchId: "a".repeat(32),
        sourceKind: "list-scan",
        nowIso,
        request,
        needsResearch: false,
        researchSummary: "Deep research summary here.",
        chain: "base",
        tokenAddress: "0x6055706234dd0cc9965400296f2ca950941f6253",
        shortLabel: request.shortLabel,
        qualificationSource: "main-track",
        status: "qualified-pending",
      })
      expect(created.delivery.deliveryId).toBe(
        trackingDeliveryIdFromIdentity(
          request.trackingId,
          "base",
          "0x6055706234dd0cc9965400296f2ca950941f6253",
        ),
      )
      // matchedSubjects not consumed until delivered
      expect(created.file.requests[0]!.matchedSubjects).toEqual([])
      await store.saveTracking(created.file)

      const channelSends: Array<{ content: string; mentions: string[] }> = []
      const client: DiscordRestClient = {
        sendReply: async () => {
          throw new Error("must not reply")
        },
        sendChannelMessage: async (args) => {
          channelSends.push({
            content: args.content,
            mentions: [...(args.mentionUserIds ?? [])],
          })
          return { messageId: `9${channelSends.length}00000000000000000`.slice(0, 19) }
        },
        addReaction: async () => undefined,
      }

      const result = await deliverTrackingAlert({
        client,
        store,
        delivery: created.delivery,
        nowIso,
      })
      expect(result.ok).toBe(true)
      expect(channelSends.length).toBeGreaterThanOrEqual(1)
      expect(channelSends[0]!.mentions).toEqual(["1000000000000000004"])
      expect(channelSends[0]!.content).toContain(
        renderTrackingFoundHeader({
          userId: "1000000000000000004",
          shortLabel: "RH AI projects",
        }),
      )
      expect(channelSends[0]!.content).toContain("Deep research summary here.")
      expect(store.loadTracking().trackingDeliveries[0]!.status).toBe("delivered")
      expect(store.loadTracking().requests[0]!.matchedSubjects).toEqual([
        "base:0x6055706234dd0cc9965400296f2ca950941f6253",
      ])
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})

import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discordLayout } from "../../src/discord/paths.js"
import { createDiscordStore, emptyTrackingFile } from "../../src/discord/store.js"
import { enqueueTrackingMatchBatch, hashTrackingCandidates } from "../../src/discord/tracking-hooks.js"
import { deliverTrackingPing } from "../../src/discord/tracking-delivery.js"
import type { DiscordRestClient } from "../../src/discord/bot-client.js"
import { createOrGetDelivery } from "../../src/discord/tracking-state.js"
import { renderTrackingPing } from "../../src/discord/tracking-sanitize.js"

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

describe("discord tracking delivery + hooks", () => {
  it("enqueues durable batches idempotently", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-trk-hook-"))
    const prevHome = process.env["HOME"]
    process.env["HOME"] = home
    try {
      const digest = JSON.stringify([{ provenance: "x:1", text: "privacy mixer" }])
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

  it("delivers ping with explicit allowed mentions and resumes parts", async () => {
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
        reason: "new privacy mixer",
        batchId: "a".repeat(32),
        sourceKind: "research",
        nowIso,
        request,
        needsResearch: false,
        researchSummary: "Deep research summary here.",
      })
      await store.saveTracking(created.file)

      const mentions: string[][] = []
      const client: DiscordRestClient = {
        sendReply: async (args) => {
          mentions.push([...(args.mentionUserIds ?? [])])
          return { messageId: `9${mentions.length}00000000000000000`.slice(0, 19) }
        },
        sendChannelMessage: async () => ({ messageId: "9000000000000000002" }),
        addReaction: async () => undefined,
      }

      const result = await deliverTrackingPing({
        client,
        store,
        delivery: created.delivery,
        nowIso,
      })
      expect(result.ok).toBe(true)
      expect(mentions[0]).toEqual(["1000000000000000004"])
      expect(store.loadTracking().trackingDeliveries[0]!.status).toBe("delivered")
      expect(renderTrackingPing("1000000000000000004", "new privacy mixer"))
        .toContain("I see talk of")
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})

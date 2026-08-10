import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ConfigSchema } from "../../src/lib/config.js"
import {
  migrateConfigToV23,
  migrateConfigToV25,
} from "../../src/migrations/config.js"

const seed = JSON.parse(
  readFileSync(join(process.cwd(), "config/seed.example.json"), "utf8"),
) as Record<string, unknown>

function asV22(): Record<string, unknown> {
  const v22 = structuredClone(seed) as Record<string, unknown>
  v22["schema"] = 22
  const research = v22["research"] as Record<string, unknown>
  delete research["farcaster_search"]
  const narratives = v22["narratives"] as Record<string, unknown>
  delete narratives["evidence_quality"]
  const broadcast = v22["broadcast"] as Record<string, unknown>
  delete broadcast["feedback"]
  return v22
}

describe("config migration v23", () => {
  it("upgrades schema 22 once to schema 23", () => {
    const migrated = migrateConfigToV23(asV22()) as Record<string, unknown>
    expect(migrated["schema"]).toBe(23)
  })

  it("is idempotent", () => {
    const once = migrateConfigToV23(asV22())
    const twice = migrateConfigToV23(once)
    expect(twice).toEqual(once)
  })

  it("turns Farcaster search off for a new installation", () => {
    const migrated = migrateConfigToV25(asV22())
    expect(ConfigSchema.parse(migrated).research.farcaster_search.enabled).toBe(false)
  })

  it("preserves an explicit schema 22 Farcaster search value", () => {
    const v22 = asV22()
    ;(v22["research"] as Record<string, unknown>)["farcaster_search"] = {
      enabled: true,
      max_casts: 12,
      recent_window_hours: 24,
    }
    const parsed = ConfigSchema.parse(migrateConfigToV25(v22))
    expect(parsed.research.farcaster_search.enabled).toBe(true)
    expect(parsed.research.farcaster_search.max_casts).toBe(12)
  })

  it("adds evidence quality defaults", () => {
    const parsed = ConfigSchema.parse(migrateConfigToV25(asV22()))
    expect(parsed.narratives.evidence_quality).toEqual({
      enabled: true,
      max_promotional_share: 0.5,
      min_independent_authors: 2,
      min_fresh_posts: 2,
      primary_source_handles: [],
    })
  })

  it("adds broadcast feedback defaults that stay off", () => {
    const parsed = ConfigSchema.parse(migrateConfigToV25(asV22()))
    expect(parsed.broadcast.feedback.enabled).toBe(false)
    expect(parsed.broadcast.feedback.followup_ttl_hours).toBe(72)
    expect(parsed.broadcast.feedback.history_days).toBe(30)
    expect(parsed.broadcast.feedback.reconcile_max_messages).toBe(100)
    expect(parsed.broadcast.feedback.candidate_min_policy_examples).toBe(5)
    expect(parsed.broadcast.feedback.candidate_min_completed_down).toBe(3)
    expect(parsed.broadcast.feedback.candidate_min_preference_pairs).toBe(2)
    expect(parsed.broadcast.feedback.channel_id).toBeUndefined()
  })

  it("preserves explicit schema 22 values", () => {
    const v22 = asV22()
    ;(v22["narratives"] as Record<string, unknown>)["retention_days"] = 21
    ;(v22["broadcast"] as Record<string, unknown>)["hot_day_min_staged_events"] = 33
    const parsed = ConfigSchema.parse(migrateConfigToV25(v22))
    expect(parsed.narratives.retention_days).toBe(21)
    expect(parsed.broadcast.hot_day_min_staged_events).toBe(33)
  })

  it("requires a channel id when feedback is enabled", () => {
    const cfg = structuredClone(seed) as Record<string, unknown>
    ;(cfg["broadcast"] as Record<string, unknown>)["feedback"] = { enabled: true }
    expect(() => ConfigSchema.parse(cfg)).toThrow(/channel_id required/u)
  })

  it("requires the feedback channel to be a Discord chat channel", () => {
    const cfg = structuredClone(seed) as Record<string, unknown>
    ;(cfg["broadcast"] as Record<string, unknown>)["feedback"] = {
      enabled: true,
      channel_id: "99999999999999999",
    }
    expect(() => ConfigSchema.parse(cfg)).toThrow(/must appear in chat.discord.channel_ids/u)
  })

  it("accepts feedback on a configured Discord chat channel", () => {
    const cfg = structuredClone(seed) as Record<string, unknown>
    const discord = (cfg["chat"] as Record<string, unknown>)["discord"] as Record<string, unknown>
    const channelId = (discord["channel_ids"] as string[])[0]
    ;(cfg["broadcast"] as Record<string, unknown>)["feedback"] = {
      enabled: true,
      channel_id: channelId,
    }
    expect(ConfigSchema.parse(cfg).broadcast.feedback.channel_id).toBe(channelId)
  })

  it("rejects feedback when Discord chat is off", () => {
    const cfg = structuredClone(seed) as Record<string, unknown>
    const discord = (cfg["chat"] as Record<string, unknown>)["discord"] as Record<string, unknown>
    const channelId = (discord["channel_ids"] as string[])[0]
    discord["enabled"] = false
    discord["wallet_signals"] = { enabled: false, shadow_mode: true, channel_ids: [] }
    ;(cfg["broadcast"] as Record<string, unknown>)["feedback"] = {
      enabled: true,
      channel_id: channelId,
    }
    expect(() => ConfigSchema.parse(cfg)).toThrow(/chat.discord.enabled required/u)
  })
})

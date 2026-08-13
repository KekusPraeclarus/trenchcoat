import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ConfigSchema } from "../../src/lib/config.js"
import { DEPLOYMENT_CONFIG_SCHEMA } from "../../src/lib/deployment.js"
import {
  migrateConfigToV26,
  migrateConfigToV27,
  PUMP_V27_DEFAULTS,
} from "../../src/migrations/config.js"

const seed = JSON.parse(
  readFileSync(join(process.cwd(), "config/seed.example.json"), "utf8"),
) as Record<string, unknown>

function asV26(): Record<string, unknown> {
  const v26 = structuredClone(seed) as Record<string, unknown>
  v26["schema"] = 26
  delete v26["pump"]
  return v26
}

describe("config migration v27", () => {
  it("upgrades schema 26 once and validates as schema 27", () => {
    const migrated = migrateConfigToV27(asV26()) as Record<string, unknown>
    expect(migrated["schema"]).toBe(27)
    expect(ConfigSchema.parse(migrated).schema).toBe(27)
  })

  it("is idempotent", () => {
    const once = migrateConfigToV27(asV26())
    const twice = migrateConfigToV27(once)
    expect(twice).toEqual(once)
  })

  it("keeps the deployment config schema aligned", () => {
    expect(DEPLOYMENT_CONFIG_SCHEMA).toBe(27)
    expect(ConfigSchema.parse(seed).schema).toBe(DEPLOYMENT_CONFIG_SCHEMA)
  })

  it("adds pump defaults off for an existing installation", () => {
    const parsed = ConfigSchema.parse(migrateConfigToV27(asV26()))
    expect(parsed.pump.enabled).toBe(false)
    expect(parsed.pump.shadow_mode).toBe(true)
    expect(parsed.pump.daily_navigation_budget).toBe(
      PUMP_V27_DEFAULTS.daily_navigation_budget,
    )
    expect(parsed.pump.following_min_follows).toBe(10)
    expect(parsed.pump.max_pages_per_feed).toBe(5)
    expect(parsed.pump.max_profile_chart_pages).toBe(5)
    expect(parsed.pump.engagement.likes_per_window).toBe(2)
    expect(parsed.pump.engagement.like_window_minutes).toBe(10)
    expect(parsed.pump.engagement.max_follows_per_run).toBe(3)
    expect(parsed.pump.leaderboard.enabled).toBe(true)
    expect(parsed.pump.leaderboard.max_handles).toBe(50)
    expect(parsed.pump.research.max_enqueues_per_day).toBe(3)
    expect(parsed.pump.calls.min_age_hours).toBe(24)
  })

  it("preserves explicit schema 26 pump values", () => {
    const v26 = asV26()
    v26["pump"] = {
      enabled: true,
      shadow_mode: false,
      daily_navigation_budget: 100,
      following_min_follows: 12,
      engagement: {
        enabled: false,
        likes_per_window: 1,
        like_window_minutes: 15,
        max_follows_per_run: 2,
      },
      leaderboard: {
        enabled: false,
        max_handles: 10,
      },
      research: {
        max_enqueues_per_day: 1,
      },
      calls: {
        min_age_hours: 48,
      },
    }
    const parsed = ConfigSchema.parse(migrateConfigToV27(v26))
    expect(parsed.pump.enabled).toBe(true)
    expect(parsed.pump.shadow_mode).toBe(false)
    expect(parsed.pump.daily_navigation_budget).toBe(100)
    expect(parsed.pump.following_min_follows).toBe(12)
    expect(parsed.pump.engagement.enabled).toBe(false)
    expect(parsed.pump.engagement.likes_per_window).toBe(1)
    expect(parsed.pump.leaderboard.enabled).toBe(false)
    expect(parsed.pump.research.max_enqueues_per_day).toBe(1)
    expect(parsed.pump.calls.min_age_hours).toBe(48)
  })

  it("lifts schema 25 through v26 into parseable schema 27", () => {
    const v25 = structuredClone(asV26())
    v25["schema"] = 25
    const research = v25["research"] as Record<string, unknown>
    delete research["social_cashtag_bridge"]
    delete v25["new_pools_feed"]
    const parsed = ConfigSchema.parse(migrateConfigToV27(migrateConfigToV26(v25)))
    expect(parsed.schema).toBe(27)
    expect(parsed.pump.enabled).toBe(false)
    expect(parsed.new_pools_feed.enabled).toBe(true)
  })
})

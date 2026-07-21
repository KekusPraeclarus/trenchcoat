import { describe, expect, it } from "vitest"
import { ConfigSchema } from "../../src/lib/config.js"
import { migrateConfigToV16 } from "../../src/migrations/config.js"

const baseV15 = {
  schema: 15,
  telegram_channels: [],
  twitter: {
    operator_list_urls: [
      "https://x.com/i/lists/1111111111111111111",
      "https://x.com/i/lists/2222222222222222222",
    ],
    scrape_home: true,
    max_pages_per_run: 5,
    managed_list: {
      name: "trenchcoat-sources",
      description: "Sources promoted by trenchcoat",
      capacity: 250,
    },
    source_lifecycle: {
      review_interval_hours: 24,
      max_transitions_per_review: 10,
      promotion: {
        min_eligible_calls: 10,
        min_distinct_tokens: 5,
        min_coverage: 0.8,
        min_hit_mean: 0.6,
        min_hit_lb95: 0.45,
        min_median_excess: 0.05,
        max_rug_exposure: 0.1,
        max_idle_days: 14,
      },
      demotion: {
        idle_days: 30,
        rug_exposure: 0.25,
        min_resolved_for_rug_drop: 4,
        coverage_floor: 0.5,
        score_floor: 0.4,
        consecutive_epochs: 2,
        readd_cooldown_days: 30,
        readd_min_new_calls: 5,
      },
    },
    engagement: {
      enabled: true,
      likes_per_window: 2,
      like_window_minutes: 10,
    },
  },
  research: {},
  broadcast: {},
  indicators: {},
  gate_thresholds: {},
  audit: { rsi_promotion: {} },
  wallets: {
    deterministic_weight: 0.8,
    llm_weight: 0.2,
    promotion: {},
    drop: {},
  },
  source_safety: {},
  retention: {},
  chat: {
    idle_timeout_minutes: 30,
    research_confirm_ttl_minutes: 15,
    discord: {
      enabled: false,
      channel_ids: [],
      per_user_daily_cap: 5,
      server_daily_cap: 20,
      max_active_per_user: 5,
      model: "composer-2.5-fast",
      watch_days: 30,
      watch_scan_hours: 6,
      max_watched_tokens: 500,
      max_subscribers_per_token: 100,
    },
  },
  router: {},
}

describe("config migration v16", () => {
  it("strips Discord research caps and adds conversation defaults", () => {
    const migrated = migrateConfigToV16(baseV15) as Record<string, unknown>
    expect(migrated["schema"]).toBe(16)
    const discord = ((migrated["chat"] as Record<string, unknown>)["discord"]
      ?? {}) as Record<string, unknown>
    expect(discord["per_user_daily_cap"]).toBeUndefined()
    expect(discord["server_daily_cap"]).toBeUndefined()
    expect(discord["max_active_per_user"]).toBeUndefined()
    expect(discord["watch_expiry_reply_window_days"]).toBe(7)
    const conversation = discord["conversation"] as Record<string, unknown>
    expect(conversation["enabled"]).toBe(false)
    expect(conversation["model"]).toBe("composer-2.5")
    expect(conversation["max_research_per_turn"]).toBe(5)
    expect(ConfigSchema.parse(migrated).schema).toBe(16)
  })
})

import { z } from "zod"

export const ConfigV1Schema = z.object({
  schema: z.literal(1),
  telegram_channels: z.array(z.string()).default([]),
  twitter: z.object({
    curated_list_url: z.string().url().optional(),
    max_pages_per_run: z.number().int().default(5),
  }).default({}),
}).passthrough()

const ConfigV2Schema = z.object({
  schema: z.literal(2),
  twitter: z.object({
    curated_list_url: z.string().url().optional(),
    scrape_home: z.boolean().default(true),
    max_pages_per_run: z.number().int().default(5),
  }),
}).passthrough()

export function migrateConfigToV2(raw: unknown): unknown {
  const asRecord = raw as Record<string, unknown>
  if (asRecord && asRecord["schema"] === 2) return raw
  const v1 = ConfigV1Schema.parse(raw)
  const channels = v1.telegram_channels.map((channel) => ({
    channel,
    mode: "preview" as const,
  }))
  return {
    schema: 2,
    telegram_channels: channels,
    twitter: { ...v1.twitter, },
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
    chat: {},
    router: {},
  }
}

export function migrateConfigToV3(raw: unknown): unknown {
  const record = raw as Record<string, unknown> | null
  if (record?.["schema"] === 3 || record?.["schema"] === 4) return raw

  const v2 = ConfigV2Schema.parse(
    record?.["schema"] === 1 ? migrateConfigToV2(raw) : raw,
  )
  const primary = v2.twitter.curated_list_url
    ?? "https://x.com/i/lists/REPLACE_WITH_FIRST_LIST_ID"

  return {
    ...v2,
    schema: 3,
    twitter: {
      operator_list_urls: [
        primary,
        "https://x.com/i/lists/REPLACE_WITH_SECOND_LIST_ID",
      ],
      scrape_home: v2.twitter.scrape_home,
      max_pages_per_run: v2.twitter.max_pages_per_run,
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
          min_coverage: 0.80,
          min_hit_mean: 0.60,
          min_hit_lb95: 0.45,
          min_median_excess: 0.05,
          max_rug_exposure: 0.10,
          max_idle_days: 14,
        },
        demotion: {
          idle_days: 30,
          rug_exposure: 0.25,
          min_resolved_for_rug_drop: 4,
          coverage_floor: 0.50,
          score_floor: 0.40,
          consecutive_epochs: 2,
          readd_cooldown_days: 30,
          readd_min_new_calls: 5,
        },
      },
    },
  }
}

export function migrateConfigToV4(raw: unknown): unknown {
  const record = raw as Record<string, unknown> | null
  if (record?.["schema"] === 4 || record?.["schema"] === 5 || record?.["schema"] === 6 || record?.["schema"] === 7) return raw
  const v3 = migrateConfigToV3(raw) as Record<string, unknown>
  const twitter = (v3["twitter"] ?? {}) as Record<string, unknown>
  return {
    ...v3,
    schema: 4,
    twitter: {
      ...twitter,
      engagement: {
        enabled: true,
        likes_per_window: 2,
        like_window_minutes: 10,
      },
    },
  }
}

export function migrateConfigToV5(raw: unknown): unknown {
  const record = raw as Record<string, unknown> | null
  if (record?.["schema"] === 5 || record?.["schema"] === 6 || record?.["schema"] === 7) return raw
  const v4 = migrateConfigToV4(raw) as Record<string, unknown>
  return {
    ...v4,
    schema: 5,
    harness_improvement: {
      enabled: false,
      schedule_enabled: false,
      auto_open_pr: true,
      base_branch: "main",
      test_command: "test:unit",
      require_two_epochs: true,
      allocation_bps: 1_000,
      min_events: 40,
      min_holdout_events: 20,
      confidence_level: 0.95,
      error_budget: 3,
      missingness_max: 0.3,
      rug_exposure_max: 0.25,
      one_active_experiment: true,
    },
  }
}

export function migrateConfigToV6(raw: unknown): unknown {
  const record = raw as Record<string, unknown> | null
  if (record?.["schema"] === 6 || record?.["schema"] === 7) return raw
  const v5 = migrateConfigToV5(raw) as Record<string, unknown>
  const research = (v5["research"] ?? {}) as Record<string, unknown>
  return {
    ...v5,
    schema: 6,
    farcaster: {
      enabled: false,
      scrape_for_you: true,
      max_items_per_feed: 25,
      follow_graph: { capacity: 250 },
      source_lifecycle: {
        review_interval_hours: 24,
        max_transitions_per_review: 10,
        promotion: {
          min_eligible_calls: 10,
          min_distinct_tokens: 5,
          min_coverage: 0.80,
          min_hit_mean: 0.60,
          min_hit_lb95: 0.45,
          min_median_excess: 0.05,
          max_rug_exposure: 0.10,
          max_idle_days: 14,
        },
        demotion: {
          idle_days: 30,
          rug_exposure: 0.25,
          min_resolved_for_rug_drop: 4,
          coverage_floor: 0.50,
          score_floor: 0.40,
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
    research: {
      ...research,
      farcaster_search: {
        enabled: true,
        max_casts: 40,
        recent_window_hours: 48,
      },
    },
  }
}

export function migrateConfigToV7(raw: unknown): unknown {
  const record = raw as Record<string, unknown> | null
  if (record?.["schema"] === 7) return raw
  const v6 = migrateConfigToV6(raw) as Record<string, unknown>
  return {
    ...v6,
    schema: 7,
    narratives: {
      retention_days: 14,
    },
    review: {
      lookback_days: 7,
      max_reports: 30,
    },
  }
}

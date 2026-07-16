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
  if (record?.["schema"] === 4) return raw
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

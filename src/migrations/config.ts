import { z } from "zod"

export const ConfigV1Schema = z.object({
  schema: z.literal(1),
  telegram_channels: z.array(z.string()).default([]),
  twitter: z.object({
    curated_list_url: z.string().url().optional(),
    max_pages_per_run: z.number().int().default(5),
  }).default({}),
}).passthrough()

export function migrateConfigToV2(raw: unknown): unknown {
  const asRecord = raw as Record<string, unknown>
  if (asRecord && asRecord["schema"] === 2) return raw
  const v1 = ConfigV1Schema.parse(raw)
  const channels = v1.telegram_channels.map((channel) => ({
    channel,
    mode: "preview" as const,
    consentRef: "ops/permissions/telegram-pending.txt",
  }))
  return {
    schema: 2,
    telegram_channels: channels,
    twitter: {
      ...v1.twitter,
      scraping_permission_ref: "ops/permissions/x-scraping.txt",
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
    chat: {},
    router: {},
  }
}

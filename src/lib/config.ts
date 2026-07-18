import { z } from "zod"
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { sha256Json } from "./canonical-json.js"
import { migrateConfigToV7 } from "../migrations/config.js"
import { writeAtomicFile } from "./fs-atomic.js"

const ChannelSchema = z.object({
  channel: z.string().min(1).max(128),
  mode: z.enum(["preview", "gramjs"])
})

export const ConfigSchema = z.object({
  schema: z.literal(7),
  telegram_channels: z.array(ChannelSchema).default([]),
  twitter: z.object({
    operator_list_urls: z.tuple([z.string().url(), z.string().url()]),
    scrape_home: z.boolean().default(true),
    max_pages_per_run: z.number().int().min(1).max(20).default(5),
    managed_list: z.object({
      name: z.string().min(1).max(25).default("trenchcoat-sources"),
      description: z.string().max(100).default("Sources promoted by trenchcoat"),
      capacity: z.number().int().min(1).max(500).default(250),
      list_id: z.string().regex(/^\d+$/u).optional(),
      list_url: z.string().url().optional(),
    }),
    source_lifecycle: z.object({
      review_interval_hours: z.number().int().min(1).max(168).default(24),
      max_transitions_per_review: z.number().int().min(1).max(50).default(10),
      promotion: z.object({
        min_eligible_calls: z.number().int().min(1).default(10),
        min_distinct_tokens: z.number().int().min(1).default(5),
        min_coverage: z.number().min(0).max(1).default(0.80),
        min_hit_mean: z.number().min(0).max(1).default(0.60),
        min_hit_lb95: z.number().min(0).max(1).default(0.45),
        min_median_excess: z.number().default(0.05),
        max_rug_exposure: z.number().min(0).max(1).default(0.10),
        max_idle_days: z.number().int().min(1).default(14),
      }),
      demotion: z.object({
        idle_days: z.number().int().min(1).default(30),
        rug_exposure: z.number().min(0).max(1).default(0.25),
        min_resolved_for_rug_drop: z.number().int().min(1).default(4),
        coverage_floor: z.number().min(0).max(1).default(0.50),
        score_floor: z.number().min(0).max(1).default(0.40),
        consecutive_epochs: z.number().int().min(1).default(2),
        readd_cooldown_days: z.number().int().min(1).default(30),
        readd_min_new_calls: z.number().int().min(1).default(5),
      }),
    }),
    engagement: z.object({
      enabled: z.boolean().default(true),
      // hard-bounded to close the INV-S22 / INV-R2 throttle gap: at most 2 likes
      // per window, window no shorter than 10 minutes
      likes_per_window: z.number().int().min(0).max(2).default(2),
      like_window_minutes: z.number().int().min(10).max(1_440).default(10),
    }),
  }),
  farcaster: z.object({
    enabled: z.boolean().default(false),
    bot_fid: z.number().int().positive().optional(),
    scrape_for_you: z.boolean().default(true),
    operator_channel_ids: z.tuple([
      z.string().regex(/^[A-Za-z0-9-]{1,128}$/u),
      z.string().regex(/^[A-Za-z0-9-]{1,128}$/u),
    ]).optional(),
    max_items_per_feed: z.number().int().min(1).max(50).default(25),
    follow_graph: z.object({
      capacity: z.number().int().min(1).max(500).default(250),
    }).default({ capacity: 250 }),
    source_lifecycle: z.object({
      review_interval_hours: z.number().int().min(1).max(168).default(24),
      max_transitions_per_review: z.number().int().min(1).max(50).default(10),
      promotion: z.object({
        min_eligible_calls: z.number().int().min(1).default(10),
        min_distinct_tokens: z.number().int().min(1).default(5),
        min_coverage: z.number().min(0).max(1).default(0.80),
        min_hit_mean: z.number().min(0).max(1).default(0.60),
        min_hit_lb95: z.number().min(0).max(1).default(0.45),
        min_median_excess: z.number().default(0.05),
        max_rug_exposure: z.number().min(0).max(1).default(0.10),
        max_idle_days: z.number().int().min(1).default(14),
      }),
      demotion: z.object({
        idle_days: z.number().int().min(1).default(30),
        rug_exposure: z.number().min(0).max(1).default(0.25),
        min_resolved_for_rug_drop: z.number().int().min(1).default(4),
        coverage_floor: z.number().min(0).max(1).default(0.50),
        score_floor: z.number().min(0).max(1).default(0.40),
        consecutive_epochs: z.number().int().min(1).default(2),
        readd_cooldown_days: z.number().int().min(1).default(30),
        readd_min_new_calls: z.number().int().min(1).default(5),
      }),
    }),
    engagement: z.object({
      enabled: z.boolean().default(true),
      likes_per_window: z.number().int().min(0).max(2).default(2),
      like_window_minutes: z.number().int().min(10).max(1_440).default(10),
    }),
  }).default({
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
  }),
  research: z.object({
    daily_cap: z.number().int().min(1).max(20).default(3),
    disambiguation_daily_cap: z.number().int().min(1).max(50).default(10),
    queue_expiry_days: z.number().int().min(1).max(60).default(14),
    revisit_default_days: z.number().int().min(1).max(30).default(7),
    web_search: z.object({
      enabled: z.boolean().default(true),
      max_queries_per_run: z.number().int().min(0).max(5).default(3),
    }).default({}),
    twitter_search: z.object({
      enabled: z.boolean().default(true),
      max_pages_per_query: z.number().int().min(1).max(5).default(2),
      max_posts: z.number().int().min(1).max(100).default(40),
      recent_window_hours: z.number().int().min(1).max(168).default(48),
    }).default({}),
    farcaster_search: z.object({
      enabled: z.boolean().default(true),
      max_casts: z.number().int().min(1).max(100).default(40),
      recent_window_hours: z.number().int().min(1).max(168).default(48),
    }).default({}),
  }),
  broadcast: z.object({
    daily_budget: z.number().int().min(0).max(50).default(5),
    urgent_ceiling: z.number().int().min(1).max(100).default(10),
    discord_distiller: z.object({
      enabled: z.boolean().default(false),
      daily_cap: z.number().int().min(0).max(50).default(10),
    }).default({ enabled: false, daily_cap: 10 }),
  }),
  narratives: z.object({
    retention_days: z.number().int().min(1).max(90).default(14),
  }).default({ retention_days: 14 }),
  review: z.object({
    lookback_days: z.number().int().min(1).max(90).default(7),
    max_reports: z.number().int().min(1).max(100).default(30),
  }).default({ lookback_days: 7, max_reports: 30 }),
  indicators: z.object({
    feature_spec_version: z.number().int().min(1).default(1),
    rsi_period: z.number().int().min(2).max(50).default(14),
    rsi_timeframes_minutes: z.array(z.number().int()).default([60, 240]),
    rsi_overbought: z.number().min(50).max(100).default(70),
    rsi_min_active_bars: z.number().int().min(1).max(14).default(10),
  }),
  gate_thresholds: z.object({
    sell_tax_max: z.number().min(0).max(1).default(0.20),
    lp_locked_min: z.number().min(0).max(1).default(0.80),
    holder_top10_max: z.number().min(0).max(1).default(0.50),
    liquidity_floor_usd: z.number().min(0).default(30_000),
    txns_24h_min: z.number().int().min(0).default(150),
    fdv_liquidity_max: z.number().min(0).default(100),
    liquidity_delta_min: z.number().max(0).default(-0.30),
  }),
  audit: z.object({
    horizons_hours: z.array(z.number().int()).default([24, 72, 168]),
    headline_horizon_hours: z.number().int().default(72),
    outcome_settlement_hours: z.number().int().default(6),
    execution_bar_minutes: z.number().int().default(5),
    execution_model_version: z.number().int().default(1),
    execution_fee_bps_per_side: z.number().int().default(50),
    hit_threshold: z.number().min(0).max(10).default(0.20),
    source_score_half_life_days: z.number().int().default(30),
    source_score_prior_strength: z.number().int().default(10),
    source_call_dedupe_hours: z.number().int().default(24),
    attribution_lookback_days: z.number().int().default(7),
    rsi_promotion: z.object({
      min_ground_truth_events: z.number().int().default(100),
      min_holdout_events: z.number().int().default(40),
      confidence_level: z.number().min(0).max(1).default(0.95),
    }),
  }),
  harness_improvement: z.object({
    enabled: z.boolean().default(false),
    schedule_enabled: z.boolean().default(false),
    auto_open_pr: z.boolean().default(true),
    base_branch: z.string().min(1).max(128).default("main"),
    test_command: z.string().min(1).max(64).default("test:unit"),
    require_two_epochs: z.boolean().default(true),
    allocation_bps: z.number().int().min(0).max(10_000).default(1_000),
    min_events: z.number().int().min(1).default(40),
    min_holdout_events: z.number().int().min(1).default(20),
    confidence_level: z.number().min(0).max(1).default(0.95),
    error_budget: z.number().int().min(0).default(3),
    missingness_max: z.number().min(0).max(1).default(0.3),
    rug_exposure_max: z.number().min(0).max(1).default(0.25),
    one_active_experiment: z.boolean().default(true),
  }).default({
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
  }),
  wallets: z.object({
    deterministic_weight: z.number().min(0).max(1).default(0.80),
    llm_weight: z.number().min(0).max(1).default(0.20),
    discovery_interval_hours: z.number().int().default(6),
    solana_scan_minutes: z.number().int().default(5),
    evm_scan_minutes: z.number().int().default(15),
    max_transitions_per_review: z.number().int().default(20),
    promotion: z.object({
      min_effective_buys: z.number().int().default(15),
      min_distinct_tokens: z.number().int().default(8),
      min_coverage: z.number().min(0).max(1).default(0.80),
      min_deterministic: z.number().min(0).max(1).default(0.65),
      min_blended: z.number().min(0).max(1).default(0.70),
      min_hit_mean: z.number().min(0).max(1).default(0.65),
      min_hit_lb95: z.number().min(0).max(1).default(0.50),
      min_median_excess: z.number().default(0.10),
      max_rug_exposure: z.number().min(0).max(1).default(0.10),
      max_idle_days: z.number().int().default(14),
    }),
    drop: z.object({
      idle_days: z.number().int().default(45),
      rug_exposure: z.number().min(0).max(1).default(0.25),
      coverage_floor: z.number().min(0).max(1).default(0.50),
      deterministic_floor: z.number().min(0).max(1).default(0.40),
      blended_floor: z.number().min(0).max(1).default(0.45),
      readd_cooldown_days: z.number().int().default(30),
      readd_min_new_events: z.number().int().default(5),
    }),
  }),
  source_safety: z.object({
    intent_classifier_daily_cap: z.number().int().default(20),
  }),
  retention: z.object({
    inbox_archive_days: z.number().int().default(30),
    run_archive_days: z.number().int().default(90),
    chat_reports_days: z.number().int().default(30),
  }),
  chat: z.object({
    idle_timeout_minutes: z.number().int().default(30),
    research_confirm_ttl_minutes: z.number().int().min(1).max(120).default(15),
  }),
  router: z.object({
    bind_host: z.string().default("127.0.0.1"),
    bind_port: z.number().int().default(8787),
    telegram_chat_id: z.string().optional(),
    discord_webhook_url: z.string().url().optional(),
  }),
}).superRefine((cfg, ctx) => {
  if (cfg.twitter.operator_list_urls[0] === cfg.twitter.operator_list_urls[1]) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "twitter.operator_list_urls must contain two distinct lists",
      path: ["twitter", "operator_list_urls"],
    })
  }
  if (
    cfg.farcaster.operator_channel_ids
    && cfg.farcaster.operator_channel_ids[0] === cfg.farcaster.operator_channel_ids[1]
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "farcaster.operator_channel_ids must contain two distinct channels",
      path: ["farcaster", "operator_channel_ids"],
    })
  }
  if (
    cfg.twitter.managed_list.list_id !== undefined
    && cfg.twitter.managed_list.list_url === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "managed list_url is required when list_id is set",
      path: ["twitter", "managed_list"],
    })
  }
  if (Math.abs(cfg.wallets.deterministic_weight + cfg.wallets.llm_weight - 1) > 1e-9) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "wallet deterministic_weight + llm_weight must equal 1",
      path: ["wallets"],
    })
  }
})

export type TrenchcoatConfig = z.infer<typeof ConfigSchema>

export type EnvSecrets = Readonly<{
  routerUrl: string
  routerToken: string
  routerHmacKey: string
  telegramBotToken: string
  telegramOperatorId: string
  /** Optional — Cursor CLI login is preferred (`agent login`) */
  cursorApiKey?: string
  telegramRouterBotToken?: string
  goplusAppKey?: string
  goplusAppSecret?: string
  coingeckoDemoKey?: string
  neynarApiKey?: string
  heliusApiKey?: string
  infuraApiKey?: string
  telegramApiId?: string
  telegramApiHash?: string
  tavilyApiKey?: string
  neynarWalletId?: string
  /** App FID that sponsors SignedKeyRequest metadata during account creation */
  farcasterAppFid?: string
  /** App custody mnemonic for SignedKeyRequest during account creation */
  farcasterAppMnemonic?: string
}>

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env ${name}`)
  }
  return value.trim()
}

export function loadEnvSecrets(requireAll = false): EnvSecrets {
  const base: EnvSecrets = {
    routerUrl: requireEnv("TRENCHCOAT_ROUTER_URL"),
    routerToken: requireEnv("TRENCHCOAT_ROUTER_TOKEN"),
    routerHmacKey: requireEnv("TRENCHCOAT_ROUTER_HMAC_KEY"),
    telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    telegramOperatorId: requireEnv("TELEGRAM_OPERATOR_ID"),
  }

  const optional = {
    cursorApiKey: process.env["CURSOR_API_KEY"],
    telegramRouterBotToken: process.env["TELEGRAM_ROUTER_BOT_TOKEN"],
    goplusAppKey: process.env["GOPLUS_APP_KEY"],
    goplusAppSecret: process.env["GOPLUS_APP_SECRET"],
    coingeckoDemoKey: process.env["COINGECKO_DEMO_KEY"],
    neynarApiKey: process.env["NEYNAR_API_KEY"],
    heliusApiKey: process.env["HELIUS_API_KEY"],
    infuraApiKey: process.env["INFURA_API_KEY"],
    telegramApiId: process.env["TELEGRAM_API_ID"],
    telegramApiHash: process.env["TELEGRAM_API_HASH"],
    tavilyApiKey: process.env["TAVILY_API_KEY"],
    neynarWalletId: process.env["NEYNAR_WALLET_ID"],
    farcasterAppFid: process.env["FARCASTER_APP_FID"],
    farcasterAppMnemonic: process.env["FARCASTER_APP_MNEMONIC"],
  }

  if (requireAll) {
    for (const [key, value] of Object.entries(optional)) {
      if (key === "cursorApiKey") continue
      // Farcaster create-account secrets are only needed for auth farcaster --create
      if (
        key === "neynarWalletId"
        || key === "farcasterAppFid"
        || key === "farcasterAppMnemonic"
      ) continue
      if (!value) throw new Error(`Missing required env for live mode: ${key}`)
    }
  }

  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(optional).filter(([, value]) => Boolean(value)),
    ),
  }
}

export function defaultConfigPath(): string {
  return join(homedir(), ".trenchcoat", "config.json")
}

export function loadConfig(path = defaultConfigPath()): TrenchcoatConfig {
  if (!existsSync(path)) {
    throw new Error(`Config not found at ${path}`)
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown
  return ConfigSchema.parse(migrateConfigToV7(raw))
}

export function validateConfigFile(path = defaultConfigPath()): Readonly<{
  ok: true
  schema: number
  path: string
}> {
  const cfg = loadConfig(path)
  return { ok: true, schema: cfg.schema, path }
}

export async function migrateAndSaveConfig(
  path = defaultConfigPath(),
): Promise<Readonly<{ schema: number; path: string }>> {
  const cfg = loadConfig(path)
  await saveConfig(cfg, path)
  return { schema: cfg.schema, path }
}

export function securityThresholdsFromConfig(
  config: TrenchcoatConfig,
): Readonly<{
  sellTaxMax: number
  lpLockedMin: number
  holderTop10Max: number
  liquidityFloorUsd: number
  txns24hMin: number
  fdvLiquidityMax: number
  liquidityDeltaMin: number
}> {
  const t = config.gate_thresholds
  return {
    sellTaxMax: t.sell_tax_max,
    lpLockedMin: t.lp_locked_min,
    holderTop10Max: t.holder_top10_max,
    liquidityFloorUsd: t.liquidity_floor_usd,
    txns24hMin: t.txns_24h_min,
    fdvLiquidityMax: t.fdv_liquidity_max,
    liquidityDeltaMin: t.liquidity_delta_min,
  }
}

export async function saveConfig(
  config: TrenchcoatConfig,
  path = defaultConfigPath(),
): Promise<void> {
  const parsed = ConfigSchema.parse(config)
  await writeAtomicFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 0o600)
}

export function configHash(config: TrenchcoatConfig): `sha256:${string}` {
  return sha256Json(config as never)
}
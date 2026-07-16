import { z } from "zod"
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { sha256Json } from "./canonical-json.js"

const ChannelSchema = z.object({
  channel: z.string().min(1).max(128),
  mode: z.enum(["preview", "gramjs"]),
  consentRef: z.string().min(1).max(512),
})

export const ConfigSchema = z.object({
  schema: z.literal(2),
  telegram_channels: z.array(ChannelSchema).default([]),
  twitter: z.object({
    curated_list_url: z.string().url().optional(),
    max_pages_per_run: z.number().int().min(1).max(20).default(5),
    scraping_permission_ref: z.string().min(1).max(512),
  }),
  research: z.object({
    daily_cap: z.number().int().min(1).max(20).default(3),
    disambiguation_daily_cap: z.number().int().min(1).max(50).default(10),
    queue_expiry_days: z.number().int().min(1).max(60).default(14),
    revisit_default_days: z.number().int().min(1).max(30).default(7),
  }),
  broadcast: z.object({
    daily_budget: z.number().int().min(0).max(50).default(5),
    urgent_ceiling: z.number().int().min(1).max(100).default(10),
  }),
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
  }),
  router: z.object({
    bind_host: z.string().default("127.0.0.1"),
    bind_port: z.number().int().default(8787),
    telegram_chat_id: z.string().optional(),
    discord_webhook_url: z.string().url().optional(),
  }),
}).superRefine((cfg, ctx) => {
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
  }

  if (requireAll) {
    for (const [key, value] of Object.entries(optional)) {
      if (key === "cursorApiKey") continue
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
  return ConfigSchema.parse(raw)
}

export function configHash(config: TrenchcoatConfig): `sha256:${string}` {
  return sha256Json(config as never)
}

export function assertSocialPermissions(config: TrenchcoatConfig): void {
  if (!config.twitter.scraping_permission_ref.trim()) {
    throw new Error("twitter.scraping_permission_ref is required")
  }
  for (const channel of config.telegram_channels) {
    if (!channel.consentRef.trim()) {
      throw new Error(`telegram channel ${channel.channel} missing consentRef`)
    }
  }
}

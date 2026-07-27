import { z } from "zod"
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { sha256Json } from "./canonical-json.js"
import { migrateConfigToV22 } from "../migrations/config.js"
import { writeAtomicFile } from "./fs-atomic.js"

const ChannelSchema = z.object({
  channel: z.string().min(1).max(128),
  mode: z.enum(["preview", "gramjs"])
})

export const ConfigSchema = z.object({
  schema: z.literal(22),
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
    // Telegram topic deep-dive LLM
    telegram_overview: z.object({
      enabled: z.boolean().default(false),
      daily_cap: z.number().int().min(0).max(200).default(10),
      llm_budget_fraction: z.number().min(0).max(1).default(0.5),
      hot_day_llm_budget_fraction: z.number().min(0).max(1).default(0.25),
    }).default({
      enabled: false,
      daily_cap: 10,
      llm_budget_fraction: 0.5,
      hot_day_llm_budget_fraction: 0.25,
    }),
    // Host-only daily Telegram narrative map (04:00 Europe/London)
    telegram_digest: z.object({
      enabled: z.boolean().default(false),
    }).default({ enabled: false }),
    hot_day_min_staged_events: z.number().int().min(1).max(500).default(20),
    // Host LLM gate: approve/reject agent market broadcasts before stage (INV-B2)
    worthiness: z.object({
      enabled: z.boolean().default(true),
      model: z.string().min(1).max(64).default("composer-2.5-fast"),
    }).default({ enabled: true, model: "composer-2.5-fast" }),
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
    enabled: z.boolean().default(true),
    schedule_enabled: z.boolean().default(true),
    /** @deprecated PR path retired; kept optional for old configs */
    auto_open_pr: z.boolean().default(false),
    base_branch: z.string().min(1).max(128).default("main"),
    test_command: z.string().min(1).max(64).default("test:all"),
    require_two_epochs: z.boolean().default(true),
    integrate_local_main: z.boolean().default(true),
    /** After ff-only integrate, push candidate → origin/main (INV-S24) */
    push_origin: z.boolean().default(true),
    deploy_runtime: z.boolean().default(true),
    defer_agent_activation: z.boolean().default(true),
    planner_model: z.string().min(1).max(128).default("composer-2.5"),
    reviewer_model: z.string().min(1).max(128).default("composer-2.5"),
    builder_model: z.string().min(1).max(128).default("composer-2.5"),
    allocation_bps: z.number().int().min(0).max(10_000).default(1_000),
    min_events: z.number().int().min(1).default(40),
    min_holdout_events: z.number().int().min(1).default(20),
    min_mature_paired: z.number().int().min(1).default(40),
    confidence_level: z.number().min(0).max(1).default(0.95),
    error_budget: z.number().int().min(0).default(3),
    missingness_max: z.number().min(0).max(1).default(0.3),
    rug_exposure_max: z.number().min(0).max(1).default(0.25),
    one_active_experiment: z.boolean().default(true),
    meta_enabled: z.boolean().default(true),
    meta_schedule_enabled: z.boolean().default(true),
    meta_min_paired_trials: z.number().int().min(1).max(64).default(8),
    meta_schedule_days: z.number().int().min(1).max(365).default(30),
    meta_require_operator_promotion: z.boolean().default(true),
  }).default({
    enabled: true,
    schedule_enabled: true,
    auto_open_pr: false,
    base_branch: "main",
    test_command: "test:all",
    require_two_epochs: true,
    integrate_local_main: true,
    push_origin: true,
    deploy_runtime: true,
    defer_agent_activation: true,
    planner_model: "composer-2.5",
    reviewer_model: "composer-2.5",
    builder_model: "composer-2.5",
    allocation_bps: 1_000,
    min_events: 40,
    min_holdout_events: 20,
    min_mature_paired: 40,
    confidence_level: 0.95,
    error_budget: 3,
    missingness_max: 0.3,
    rug_exposure_max: 0.25,
    one_active_experiment: true,
    meta_enabled: true,
    meta_schedule_enabled: true,
    meta_min_paired_trials: 8,
    meta_schedule_days: 30,
    meta_require_operator_promotion: true,
  }),
  incident_remediation: z.object({
    enabled: z.boolean().default(false),
    schedule_enabled: z.boolean().default(false),
    hourly_interval_s: z.number().int().min(300).max(86_400).default(3_600),
    triage_model: z.string().min(1).max(128).default("composer-2.5-fast"),
    diagnose_model: z.string().min(1).max(128).default("composer-2.5-fast"),
    propose_model: z.string().min(1).max(128).default("cursor-grok-4.5-high"),
    review_model: z.string().min(1).max(128).default("composer-2.5-fast"),
    build_model: z.string().min(1).max(128).default("cursor-grok-4.5-high"),
    max_active: z.number().int().min(1).max(1).default(1),
    max_immediate_builds_per_utc_day: z.number().int().min(0).max(10).default(2),
    max_origin_move_rebuilds: z.number().int().min(0).max(3).default(1),
    max_weekly_deferred: z.number().int().min(0).max(5).default(1),
    approval_ttl_hours: z.number().int().min(1).max(168).default(24),
    max_evidence_bytes: z.number().int().min(1_000).max(2_000_000).default(100_000),
    max_diff_lines: z.number().int().min(50).max(2_000).default(400),
    phase_timeout_ms: z.number().int().min(60_000).max(3_600_000).default(1_800_000),
    revalidation: z.object({
      enabled: z.boolean().default(true),
      required_healthy_observations: z.number().int().min(1).max(10).default(2),
      max_rounds: z.number().int().min(1).max(20).default(3),
      max_wait_hours: z.number().int().min(1).max(168).default(24),
      evaluate_model: z.string().min(1).max(128).default("composer-2.5-fast"),
      review_model: z.string().min(1).max(128).default("composer-2.5-fast"),
      auto_correct: z.boolean().default(true),
    }).default({
      enabled: true,
      required_healthy_observations: 2,
      max_rounds: 3,
      max_wait_hours: 24,
      evaluate_model: "composer-2.5-fast",
      review_model: "composer-2.5-fast",
      auto_correct: true,
    }),
    discord_suggestions: z.object({
      enabled: z.boolean().default(false),
      channel_ids: z.array(z.string().regex(/^\d{17,20}$/u)).max(20).default([]),
      classifier_model: z.string().min(1).max(128).default("composer-2.5-fast"),
      max_new_incidents_per_scan: z.number().int().min(0).max(10).default(3),
      max_active_suggestion_incidents: z.number().int().min(0).max(5).default(1),
      forming_ttl_days: z.number().int().min(1).max(30).default(7),
      max_forming_rounds: z.number().int().min(1).max(20).default(5),
      ambient_thread_gap_ms: z.number().int().min(60_000).max(3_600_000).default(900_000),
      min_confidence: z.number().min(0).max(1).default(0.7),
    }).default({
      enabled: false,
      channel_ids: [],
      classifier_model: "composer-2.5-fast",
      max_new_incidents_per_scan: 3,
      max_active_suggestion_incidents: 1,
      forming_ttl_days: 7,
      max_forming_rounds: 5,
      ambient_thread_gap_ms: 900_000,
      min_confidence: 0.7,
    }),
  }).default({
    enabled: false,
    schedule_enabled: false,
    hourly_interval_s: 3_600,
    triage_model: "composer-2.5-fast",
    diagnose_model: "composer-2.5-fast",
    propose_model: "cursor-grok-4.5-high",
    review_model: "composer-2.5-fast",
    build_model: "cursor-grok-4.5-high",
    max_active: 1,
    max_immediate_builds_per_utc_day: 2,
    max_origin_move_rebuilds: 1,
    max_weekly_deferred: 1,
    approval_ttl_hours: 24,
    max_evidence_bytes: 100_000,
    max_diff_lines: 400,
    phase_timeout_ms: 1_800_000,
    revalidation: {
      enabled: true,
      required_healthy_observations: 2,
      max_rounds: 3,
      max_wait_hours: 24,
      evaluate_model: "composer-2.5-fast",
      review_model: "composer-2.5-fast",
      auto_correct: true,
    },
    discord_suggestions: {
      enabled: false,
      channel_ids: [],
      classifier_model: "composer-2.5-fast",
      max_new_incidents_per_scan: 3,
      max_active_suggestion_incidents: 1,
      forming_ttl_days: 7,
      max_forming_rounds: 5,
      ambient_thread_gap_ms: 900_000,
      min_confidence: 0.7,
    },
  }),
  wallets: z.object({
    deterministic_weight: z.number().min(0).max(1).default(0.80),
    llm_weight: z.number().min(0).max(1).default(0.20),
    discovery_interval_hours: z.number().int().default(6),
    solana_scan_minutes: z.number().int().default(5),
    evm_scan_minutes: z.number().int().default(15),
    max_wallets_per_scan: z.number().int().min(1).max(500).default(5),
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
    runner_discovery: z.object({
      enabled: z.boolean().default(false),
      shadow_mode: z.boolean().default(true),
      interval_minutes: z.number().int().min(5).max(1_440).default(30),
      max_age_hours: z.number().int().min(1).max(168).default(24),
      min_liquidity_usd: z.number().min(0).default(50_000),
      min_return_6h: z.number().default(1.0),
      min_volume_6h_usd: z.number().min(0).default(250_000),
      buyer_window_minutes: z.number().int().min(1).max(1_440).default(30),
      top_buyers_per_runner: z.number().int().min(1).max(100).default(25),
      min_runners_for_candidate: z.number().int().min(1).max(20).default(2),
      sighting_lookback_days: z.number().int().min(1).max(90).default(30),
      max_new_candidates_per_run: z.number().int().min(1).max(500).default(100),
      max_active_candidates: z.number().int().min(1).max(5_000).default(500),
      chains: z.array(z.enum(["solana", "ethereum", "base", "robinhood"])).min(1).max(8).default([
        "solana",
        "ethereum",
        "base",
        "robinhood",
      ]),
      anti_automation: z.object({
        max_buys_per_hour: z.number().int().min(1).max(1_000).default(20),
        max_distinct_tokens_per_day: z.number().int().min(1).max(1_000).default(30),
        same_slot_ratio: z.number().min(0).max(1).default(0.5),
        same_slot_min_buys: z.number().int().min(1).max(1_000).default(20),
        same_funder_cluster_max: z.number().int().min(2).max(100).default(4),
      }).default({}),
    }).default({}),
    convergence: z.object({
      enabled: z.boolean().default(false),
      shadow_mode: z.boolean().default(true),
      min_wallets: z.number().int().min(2).max(50).default(4),
      window_minutes: z.number().int().min(1).max(1_440).default(15),
      max_token_age_hours: z.number().int().min(1).max(168).default(24),
      cooldown_hours: z.number().int().min(1).max(168).default(6),
      max_alerts_per_day: z.number().int().min(0).max(100).default(10),
      max_enqueues_per_day: z.number().int().min(0).max(50).default(5),
    }).default({}),
  }),
  fomo: z.object({
    enabled: z.boolean().default(false),
    shadow_mode: z.boolean().default(true),
    daily_navigation_budget: z.number().int().min(1).max(500).default(200),
    min_delay_ms: z.number().int().min(0).max(30_000).default(1_500),
    max_delay_ms: z.number().int().min(0).max(60_000).default(3_500),
    navigation_timeout_ms: z.number().int().min(1_000).max(120_000).default(30_000),
    max_payload_bytes: z.number().int().min(1_000).max(5_000_000).default(1_000_000),
    max_event_age_hours: z.number().int().min(1).max(48).default(6),
    trader_sync: z.object({
      enabled: z.boolean().default(false),
      max_handles: z.number().int().min(1).max(200).default(50),
      max_profile_pages: z.number().int().min(1).max(100).default(20),
    }).default({}),
    signal_scan: z.object({
      enabled: z.boolean().default(false),
      feed: z.boolean().default(false),
      trending: z.boolean().default(false),
      alerts: z.boolean().default(false),
      convergence: z.boolean().default(false),
      pressure: z.boolean().default(false),
      min_trade_usd: z.number().min(0).default(500),
      convergence_window_minutes: z.number().int().min(1).max(1_440).default(60),
      min_converging_traders: z.number().int().min(2).max(50).default(2),
      pressure_window_minutes: z.number().int().min(1).max(1_440).default(60),
      min_pressure_traders: z.number().int().min(2).max(50).default(3),
      max_enqueues_per_day: z.number().int().min(0).max(50).default(3),
    }).default({}),
    theses: z.object({
      enabled: z.boolean().default(false),
      max_per_run: z.number().int().min(0).max(100).default(20),
    }).default({}),
    x_source_review: z.object({
      enabled: z.boolean().default(false),
      max_pending: z.number().int().min(1).max(500).default(100),
      max_reviews_per_day: z.number().int().min(0).max(50).default(4),
      daily_history_page_budget: z.number().int().min(1).max(200).default(20),
      lookback_days: z.number().int().min(1).max(365).default(90),
      max_posts_per_review: z.number().int().min(1).max(500).default(200),
      max_pages_per_review: z.number().int().min(1).max(20).default(5),
      min_posts: z.number().int().min(1).max(200).default(20),
      min_active_days: z.number().int().min(1).max(90).default(3),
      min_role_evidence_posts: z.number().int().min(1).max(100).default(5),
      retry_after_hours: z.number().int().min(1).max(168).default(24),
      max_attempts: z.number().int().min(1).max(10).default(3),
    }).default({}),
    narrative_source_probation: z.object({
      enabled: z.boolean().default(false),
      probation_days: z.number().int().min(1).max(90).default(14),
      max_profiles_per_scan: z.number().int().min(1).max(50).default(5),
      max_pages_per_profile: z.number().int().min(1).max(5).default(1),
      daily_profile_page_budget: z.number().int().min(1).max(200).default(20),
      min_accepted_contributions: z.number().int().min(1).max(100).default(3),
      min_distinct_narratives: z.number().int().min(1).max(50).default(2),
      demotion_idle_days: z.number().int().min(1).max(180).default(28),
    }).default({}),
  }).default({}),
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
    turn_count_max: z.number().int().min(1).max(500).default(40),
    max_prompt_chars: z.number().int().min(1_000).max(100_000).default(12_000),
    research_confirm_ttl_minutes: z.number().int().min(1).max(120).default(15),
    discord: z.object({
      enabled: z.boolean().default(false),
      guild_id: z.string().regex(/^\d{17,20}$/u).optional(),
      channel_ids: z.array(z.string().regex(/^\d{17,20}$/u)).max(20).default([]),
      /** Cursor model for Discord research sessions only */
      model: z.string().min(1).max(64).default("composer-2.5-fast"),
      watch_days: z.literal(30).default(30),
      watch_scan_hours: z.literal(6).default(6),
      watch_expiry_reply_window_days: z.number().int().min(1).max(30).default(7),
      max_watched_tokens: z.number().int().min(1).max(2_000).default(500),
      max_subscribers_per_token: z.number().int().min(1).max(500).default(100),
      conversation: z.object({
        enabled: z.boolean().default(false),
        model: z.string().min(1).max(64).default("composer-2.5"),
        classifier_model: z.string().min(1).max(64).default("composer-2.5-fast"),
        idle_timeout_minutes: z.number().int().min(1).max(1_440).default(30),
        turn_count_max: z.number().int().min(1).max(500).default(40),
        context_messages: z.number().int().min(2).max(50).default(10),
        channel_ids: z.array(z.string().regex(/^\d{17,20}$/u)).max(20).default([]),
        max_research_per_turn: z.number().int().min(1).max(10).default(5),
      }).default({}),
      chain_integration: z.object({
        enabled: z.boolean().default(true),
        max_attempts_per_utc_day: z.number().int().min(1).max(20).default(3),
        max_concurrent: z.literal(1).default(1),
        research_model: z.string().min(1).max(64).default("composer-2.5"),
        build_model: z.string().min(1).max(64).default("cursor-grok-4.5-high"),
        finalize_model: z.string().min(1).max(64).default("composer-2.5-fast"),
        provider_max_attempts: z.number().int().min(1).max(10).default(5),
        repair_max_rounds: z.number().int().min(0).max(4).default(2),
        deploy_max_attempts: z.number().int().min(1).max(3).default(2),
        phase_timeout_ms: z.number().int().min(60_000).max(3_600_000).default(1_800_000),
      }).default({}),
      tracking: z.object({
        enabled: z.boolean().default(true),
        intent_model: z.string().min(1).max(64).default("composer-2.5"),
        match_model: z.string().min(1).max(64).default("composer-2.5"),
        mention_review_model: z.string().min(1).max(64).default("composer-2.5-fast"),
        max_active_per_user: z.number().int().min(1).max(20).default(10),
        ttl_days: z.number().int().min(1).max(90).default(30),
        expiry_bundle_hours: z.number().int().min(1).max(168).default(48),
        pending_capacity_ttl_hours: z.number().int().min(1).max(168).default(48),
        tentative_confirm_window_hours: z.number().int().min(1).max(72).default(24),
        expiry_reply_window_days: z.number().int().min(1).max(30).default(7),
        match_max_attempts: z.number().int().min(1).max(16).default(5),
        match_stale_running_ms: z.number().int().min(60_000).max(3_600_000).default(900_000),
        retention_days: z.number().int().min(7).max(90).default(35),
        mention_review_blacklist_days: z.number().int().min(1).max(30).default(7),
      }).default({}),
      wallet_signals: z.object({
        enabled: z.boolean().default(false),
        shadow_mode: z.boolean().default(true),
        channel_ids: z.array(z.string().regex(/^\d{17,20}$/u)).max(20).default([]),
        scan_interval_minutes: z.number().int().min(1).max(60).default(5),
        max_message_age_hours: z.number().int().min(1).max(72).default(6),
        actor_dedupe_ttl_minutes: z.number().int().min(1).max(120).default(15),
        convergence: z.object({
          enabled: z.boolean().default(true),
          window_minutes: z.number().int().min(5).max(1440).default(60),
          min_actors: z.number().int().min(2).max(50).default(3),
        }).default({}),
        sell_pressure: z.object({
          enabled: z.boolean().default(true),
          window_minutes: z.number().int().min(5).max(1440).default(60),
          min_actors: z.number().int().min(2).max(50).default(3),
        }).default({}),
        max_enqueues_per_day: z.number().int().min(0).max(50).default(3),
      }).default({}),
    }).default({}),
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
  if (cfg.chat.discord.enabled) {
    if (!cfg.chat.discord.guild_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "chat.discord.guild_id required when chat.discord.enabled",
        path: ["chat", "discord", "guild_id"],
      })
    }
    if (cfg.chat.discord.channel_ids.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "chat.discord.channel_ids must contain 1–20 ids when enabled",
        path: ["chat", "discord", "channel_ids"],
      })
    }
    const uniqueChannels = new Set(cfg.chat.discord.channel_ids)
    if (uniqueChannels.size !== cfg.chat.discord.channel_ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "chat.discord.channel_ids must be unique",
        path: ["chat", "discord", "channel_ids"],
      })
    }
  }
  const walletSignals = cfg.chat.discord.wallet_signals
  if (walletSignals.enabled) {
    if (!cfg.chat.discord.enabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "chat.discord.enabled required when wallet_signals.enabled",
        path: ["chat", "discord", "wallet_signals", "enabled"],
      })
    }
    if (!cfg.chat.discord.guild_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "chat.discord.guild_id required when wallet_signals.enabled",
        path: ["chat", "discord", "guild_id"],
      })
    }
    if (walletSignals.channel_ids.length < 1 || walletSignals.channel_ids.length > 20) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "wallet_signals.channel_ids must contain 1–20 ids when enabled",
        path: ["chat", "discord", "wallet_signals", "channel_ids"],
      })
    }
    const uniqueWalletChannels = new Set(walletSignals.channel_ids)
    if (uniqueWalletChannels.size !== walletSignals.channel_ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "wallet_signals.channel_ids must be unique",
        path: ["chat", "discord", "wallet_signals", "channel_ids"],
      })
    }
    const researchChannels = new Set(cfg.chat.discord.channel_ids)
    const overlap = walletSignals.channel_ids.filter((id) => researchChannels.has(id))
    if (overlap.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "wallet_signals.channel_ids must be disjoint from chat.discord.channel_ids",
        path: ["chat", "discord", "wallet_signals", "channel_ids"],
      })
    }
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
  discordResearchBotToken?: string
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
    discordResearchBotToken: process.env["DISCORD_RESEARCH_BOT_TOKEN"],
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
  return ConfigSchema.parse(migrateConfigToV22(raw))
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
): Promise<Readonly<{ schema: number; path: string; researchQueueRepair?: unknown }>> {
  const cfg = loadConfig(path)
  await saveConfig(cfg, path)
  const home = join(homedir(), ".trenchcoat")
  const agentRoot = existsSync(join(home, "agent"))
    ? join(home, "agent")
    : join(process.cwd(), "agent")
  const archiveRoot = existsSync(join(home, "archive"))
    ? join(home, "archive")
    : join(process.cwd(), ".trenchcoat-local", "archive")
  let researchQueueRepair: unknown
  if (existsSync(join(agentRoot, "state"))) {
    const { migrateGenericNarrativeResearchQueue } = await import("../migrations/research-queue.js")
    researchQueueRepair = await migrateGenericNarrativeResearchQueue({
      agentRoot,
      archiveRoot,
    })
  }
  return { schema: cfg.schema, path, ...(researchQueueRepair ? { researchQueueRepair } : {}) }
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
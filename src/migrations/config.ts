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
  if (record?.["schema"] === 4 || record?.["schema"] === 5 || record?.["schema"] === 6 || record?.["schema"] === 7 || record?.["schema"] === 8 || record?.["schema"] === 9) return raw
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
  if (
    record?.["schema"] === 5
    || record?.["schema"] === 6
    || record?.["schema"] === 7
    || record?.["schema"] === 8
    || record?.["schema"] === 9
    || record?.["schema"] === 10
    || record?.["schema"] === 11
  ) {
    return raw
  }
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
  if (record?.["schema"] === 6 || record?.["schema"] === 7 || record?.["schema"] === 8 || record?.["schema"] === 9) return raw
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
  if (record?.["schema"] === 7 || record?.["schema"] === 8 || record?.["schema"] === 9) return raw
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

export function migrateConfigToV8(raw: unknown): unknown {
  const record = raw as Record<string, unknown> | null
  if (record?.["schema"] === 8 || record?.["schema"] === 9) return raw
  const v7 = migrateConfigToV7(raw) as Record<string, unknown>
  return {
    ...v7,
    schema: 8,
    fomo: {
      enabled: false,
      shadow_mode: true,
      daily_call_budget: 200,
      requests_per_minute: 8,
      timeout_ms: 15_000,
      max_response_bytes: 1_000_000,
      trader_sync: {
        enabled: false,
        max_handles: 50,
        max_wallet_candidates: 20,
      },
      signal_scan: {
        enabled: false,
        convergence: false,
        hot_tokens: false,
        activity: false,
        min_trade_usd: 500,
      },
      theses: {
        enabled: false,
        max_per_run: 20,
      },
    },
  }
}

export function defaultFomoConfigV9(): Record<string, unknown> {
  return {
    enabled: false,
    shadow_mode: true,
    daily_navigation_budget: 200,
    min_delay_ms: 1_500,
    max_delay_ms: 3_500,
    navigation_timeout_ms: 30_000,
    max_payload_bytes: 1_000_000,
    max_event_age_hours: 6,
    trader_sync: {
      enabled: false,
      max_handles: 50,
      max_profile_pages: 20,
    },
    signal_scan: {
      enabled: false,
      feed: false,
      trending: false,
      alerts: false,
      convergence: false,
      pressure: false,
      min_trade_usd: 500,
      convergence_window_minutes: 60,
      min_converging_traders: 2,
      pressure_window_minutes: 60,
      min_pressure_traders: 3,
      max_enqueues_per_day: 3,
    },
    theses: {
      enabled: false,
      max_per_run: 20,
    },
    x_source_review: {
      enabled: false,
      max_pending: 100,
      max_reviews_per_day: 4,
      daily_history_page_budget: 20,
      lookback_days: 90,
      max_posts_per_review: 200,
      max_pages_per_review: 5,
      min_posts: 20,
      min_active_days: 3,
      min_role_evidence_posts: 5,
      retry_after_hours: 24,
      max_attempts: 3,
    },
    narrative_source_probation: {
      enabled: false,
      probation_days: 14,
      max_profiles_per_scan: 5,
      max_pages_per_profile: 1,
      daily_profile_page_budget: 20,
      min_accepted_contributions: 3,
      min_distinct_narratives: 2,
      demotion_idle_days: 28,
    },
  }
}

export function migrateConfigToV9(raw: unknown): unknown {
  const record = raw as Record<string, unknown> | null
  if (
    record?.["schema"] === 9
    || record?.["schema"] === 10
    || record?.["schema"] === 11
  ) {
    return raw
  }
  const v8 = migrateConfigToV8(raw) as Record<string, unknown>
  return {
    ...v8,
    schema: 9,
    fomo: defaultFomoConfigV9(),
  }
}

export function migrateConfigToV10(raw: unknown): unknown {
  const record = raw as Record<string, unknown> | null
  if (record?.["schema"] === 10 || record?.["schema"] === 11 || record?.["schema"] === 12) return raw
  const v9 = migrateConfigToV9(raw) as Record<string, unknown>
  const chat = (v9["chat"] as Record<string, unknown> | undefined) ?? {}
  return {
    ...v9,
    schema: 10,
    chat: {
      ...chat,
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
  }
}

const HARNESS_V11_DEFAULTS = {
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
} as const

/**
 * Schema 11: agent-gated harness defaults on for new installs.
 * Preserves explicit enabled:false / schedule_enabled:false from prior configs.
 */
export function migrateConfigToV11(raw: unknown): unknown {
  const record = raw as Record<string, unknown> | null
  if (record?.["schema"] === 11 || record?.["schema"] === 12) return raw
  const v10 = migrateConfigToV10(raw) as Record<string, unknown>
  const prev = v10["harness_improvement"]
  if (prev === undefined || prev === null || typeof prev !== "object") {
    return {
      ...v10,
      schema: 11,
      harness_improvement: { ...HARNESS_V11_DEFAULTS },
    }
  }
  const old = prev as Record<string, unknown>
  return {
    ...v10,
    schema: 11,
    harness_improvement: {
      ...HARNESS_V11_DEFAULTS,
      ...old,
      // Explicit false stays false; missing keys already filled by defaults above
      enabled: old["enabled"] === false ? false : (old["enabled"] ?? true),
      schedule_enabled: old["schedule_enabled"] === false
        ? false
        : (old["schedule_enabled"] ?? true),
      auto_open_pr: old["auto_open_pr"] === true ? true : false,
    },
  }
}

const CHAIN_INTEGRATION_V12_DEFAULTS = {
  enabled: true,
  max_attempts_per_utc_day: 3,
  max_concurrent: 1,
  research_model: "composer-2.5",
  build_model: "cursor-grok-4.5-high",
  finalize_model: "composer-2.5-fast",
  provider_max_attempts: 5,
  repair_max_rounds: 2,
  deploy_max_attempts: 2,
  phase_timeout_ms: 1_800_000,
} as const

/**
 * Schema 12: Discord chain-integration lane defaults under chat.discord.
 * Preserves explicit enabled:false and numeric overrides from prior configs.
 */
export function migrateConfigToV12(raw: unknown): unknown {
  const record = raw as Record<string, unknown> | null
  if (record?.["schema"] === 12) return raw
  if (record?.["schema"] === 13) return raw
  if (record?.["schema"] === 14) return raw
  const v11 = migrateConfigToV11(raw) as Record<string, unknown>
  const chat = (v11["chat"] ?? {}) as Record<string, unknown>
  const discord = (chat["discord"] ?? {}) as Record<string, unknown>
  const prev = discord["chain_integration"]
  const merged = prev !== undefined && prev !== null && typeof prev === "object"
    ? {
      ...CHAIN_INTEGRATION_V12_DEFAULTS,
      ...(prev as Record<string, unknown>),
      enabled: (prev as Record<string, unknown>)["enabled"] === false
        ? false
        : ((prev as Record<string, unknown>)["enabled"] ?? true),
    }
    : { ...CHAIN_INTEGRATION_V12_DEFAULTS }
  return {
    ...v11,
    schema: 12,
    chat: {
      ...chat,
      discord: {
        ...discord,
        chain_integration: merged,
      },
    },
  }
}

export const INCIDENT_REMEDIATION_V13_DEFAULTS = {
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
} as const

export const INCIDENT_REMEDIATION_V14_REVALIDATION_DEFAULTS = {
  enabled: true,
  required_healthy_observations: 2,
  max_rounds: 3,
  max_wait_hours: 24,
  evaluate_model: "composer-2.5-fast",
  review_model: "composer-2.5-fast",
  auto_correct: true,
} as const

/**
 * Schema 13: host-owned incident remediation lane (hourly + weekly deferred).
 * Defaults disabled for safe rollout; preserves explicit overrides.
 */
export function migrateConfigToV13(raw: unknown): unknown {
  const record = raw as Record<string, unknown> | null
  if (record?.["schema"] === 13 || record?.["schema"] === 14) return raw

  let v12: Record<string, unknown>
  if (record?.["schema"] === 12) {
    v12 = record
  } else {
    v12 = migrateConfigToV12(raw) as Record<string, unknown>
  }

  const prev = v12["incident_remediation"]
  const merged = prev !== undefined && prev !== null && typeof prev === "object"
    ? {
      ...INCIDENT_REMEDIATION_V13_DEFAULTS,
      ...(prev as Record<string, unknown>),
      enabled: (prev as Record<string, unknown>)["enabled"] === true,
      schedule_enabled: (prev as Record<string, unknown>)["schedule_enabled"] === true,
    }
    : { ...INCIDENT_REMEDIATION_V13_DEFAULTS }

  return {
    ...v12,
    schema: 13,
    incident_remediation: merged,
  }
}

/**
 * Schema 14: post-fix claim revalidation settings under incident_remediation.
 * Parent enabled/schedule flags stay authoritative; revalidation defaults on
 * when the parent lane is present.
 */
export function migrateConfigToV14(raw: unknown): unknown {
  const record = raw as Record<string, unknown> | null
  if (record?.["schema"] === 14) return raw

  const v13 = (
    record?.["schema"] === 13
      ? record
      : migrateConfigToV13(raw)
  ) as Record<string, unknown>

  const prevIr = (v13["incident_remediation"] ?? {}) as Record<string, unknown>
  const prevRev = prevIr["revalidation"]
  const revalidation = prevRev !== undefined && prevRev !== null && typeof prevRev === "object"
    ? {
      ...INCIDENT_REMEDIATION_V14_REVALIDATION_DEFAULTS,
      ...(prevRev as Record<string, unknown>),
      enabled: (prevRev as Record<string, unknown>)["enabled"] !== false,
      auto_correct: (prevRev as Record<string, unknown>)["auto_correct"] !== false,
    }
    : { ...INCIDENT_REMEDIATION_V14_REVALIDATION_DEFAULTS }

  return {
    ...v13,
    schema: 14,
    incident_remediation: {
      ...INCIDENT_REMEDIATION_V13_DEFAULTS,
      ...prevIr,
      revalidation,
    },
  }
}

const WALLETS_RUNNER_DISCOVERY_V15_DEFAULTS = Object.freeze({
  enabled: false,
  shadow_mode: true,
  interval_minutes: 30,
  max_age_hours: 24,
  min_liquidity_usd: 50_000,
  min_return_6h: 1.0,
  min_volume_6h_usd: 250_000,
  buyer_window_minutes: 30,
  top_buyers_per_runner: 25,
  min_runners_for_candidate: 2,
  sighting_lookback_days: 30,
  max_new_candidates_per_run: 100,
  max_active_candidates: 500,
  chains: ["solana", "ethereum", "base", "robinhood"],
  anti_automation: {
    max_buys_per_hour: 20,
    max_distinct_tokens_per_day: 30,
    same_slot_ratio: 0.5,
    same_slot_min_buys: 20,
    same_funder_cluster_max: 4,
  },
})

const WALLETS_CONVERGENCE_V15_DEFAULTS = Object.freeze({
  enabled: false,
  shadow_mode: true,
  min_wallets: 4,
  window_minutes: 15,
  max_token_age_hours: 24,
  cooldown_hours: 6,
  max_alerts_per_day: 10,
  max_enqueues_per_day: 5,
})

/** Schema 15: runner discovery + tracked-wallet convergence under wallets */
export function migrateConfigToV15(raw: unknown): unknown {
  const record = raw as Record<string, unknown> | null
  if (record?.["schema"] === 15 || record?.["schema"] === 16) return raw

  const v14 = (
    record?.["schema"] === 14
      ? record
      : migrateConfigToV14(raw)
  ) as Record<string, unknown>

  const prevWallets = (v14["wallets"] ?? {}) as Record<string, unknown>
  const prevRunner = (prevWallets["runner_discovery"] ?? {}) as Record<string, unknown>
  const prevConv = (prevWallets["convergence"] ?? {}) as Record<string, unknown>
  const prevAnti = (prevRunner["anti_automation"] ?? {}) as Record<string, unknown>

  return {
    ...v14,
    schema: 15,
    wallets: {
      ...prevWallets,
      runner_discovery: {
        ...WALLETS_RUNNER_DISCOVERY_V15_DEFAULTS,
        ...prevRunner,
        anti_automation: {
          ...WALLETS_RUNNER_DISCOVERY_V15_DEFAULTS.anti_automation,
          ...prevAnti,
        },
        chains: Array.isArray(prevRunner["chains"]) && (prevRunner["chains"] as unknown[]).length > 0
          ? prevRunner["chains"]
          : WALLETS_RUNNER_DISCOVERY_V15_DEFAULTS.chains,
      },
      convergence: {
        ...WALLETS_CONVERGENCE_V15_DEFAULTS,
        ...prevConv,
      },
    },
  }
}

const DISCORD_CONVERSATION_V16_DEFAULTS = Object.freeze({
  enabled: false,
  model: "composer-2.5",
  classifier_model: "composer-2.5-fast",
  idle_timeout_minutes: 30,
  context_messages: 10,
  channel_ids: [] as string[],
  max_research_per_turn: 5,
})

/** Schema 16: drop Discord research caps; add conversation + watch expiry window */
export function migrateConfigToV16(raw: unknown): unknown {
  const record = raw as Record<string, unknown> | null
  if (record?.["schema"] === 16) return raw

  const v15 = (
    record?.["schema"] === 15
      ? record
      : migrateConfigToV15(raw)
  ) as Record<string, unknown>

  const prevChat = (v15["chat"] ?? {}) as Record<string, unknown>
  const prevDiscord = (prevChat["discord"] ?? {}) as Record<string, unknown>
  const {
    per_user_daily_cap: _userCap,
    server_daily_cap: _serverCap,
    max_active_per_user: _maxActive,
    ...discordRest
  } = prevDiscord
  const prevConversation = (prevDiscord["conversation"] ?? {}) as Record<string, unknown>

  return {
    ...v15,
    schema: 16,
    chat: {
      ...prevChat,
      discord: {
        ...discordRest,
        watch_expiry_reply_window_days:
          typeof prevDiscord["watch_expiry_reply_window_days"] === "number"
            ? prevDiscord["watch_expiry_reply_window_days"]
            : 7,
        conversation: {
          ...DISCORD_CONVERSATION_V16_DEFAULTS,
          ...prevConversation,
          channel_ids: Array.isArray(prevConversation["channel_ids"])
            ? prevConversation["channel_ids"]
            : DISCORD_CONVERSATION_V16_DEFAULTS.channel_ids,
        },
      },
    },
  }
}

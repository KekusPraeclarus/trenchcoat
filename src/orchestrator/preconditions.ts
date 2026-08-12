import { mkdirSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { appendJsonl } from "./scorecard.js"
import { StateStore } from "../lib/state.js"
import { loadConfig } from "../lib/config.js"
import { getChain } from "../lib/chains.js"
import {
  dequeueDue,
  expireQueue,
  todayCompletedCount,
} from "../lib/research-queue.js"
import { archiveLayout, ensureArchive } from "../lib/archive.js"
import { appendQueueSweepDiscoveryLogs } from "./discovery-log.js"
import { evaluateReviewPrerequisites } from "./review-collect.js"
import { getJob, type JobName } from "./jobs.js"
import { log } from "../lib/log.js"
import { systemClock } from "../lib/clock.js"
import { providerGateAllowsSchedule } from "../collectors/fomo/gates.js"
import { fomoSessionExists } from "../collectors/social/fomo-auth.js"

export type JobSkipReason =
  | "queue-empty"
  | "daily-cap"
  | "queue-pending"
  | "no-review-scope"
  | "no-active-watchlist-subjects"
  | "no-wallet-supported-subjects"
  | "no-eligible-solana-wallets"
  | "no-eligible-evm-wallets"
  | "not-initialized"
  | "fomo-disabled"
  | "fomo-missing-session"
  | "fomo-provider-gate"
  | "fomo-capability-gate"
  | "router-unconfigured"
  | "no-pending-ingress"
  | "telegram-digest-disabled"
  | "wallet-signals-disabled"
  | "wallet-signals-misconfigured"
  | "discord-token-missing"
  | "farcaster-disabled"
  | "enabled"
  | "schedule-enabled"
  | "harness-lock-held"
  | "no-active-canary"
  | "no-policy-midflight"
  | "no-meta-trialing"
  | "sealed-epochs"
  | "distinct-epochs"
  | "dev-signals"
  | "holdout-signals"
  | "holdout-unused"
  | "dev-sample-floor"
  | "holdout-sample-floor"
  | "harness-skipped"

export type JobPreconditionResult = Readonly<{
  skip: true
  reason: JobSkipReason
  details?: Readonly<Record<string, string | number | boolean>>
}>

const SAFE_JOB = /^[a-z0-9-]{1,64}$/u
const SAFE_REASON = /^[a-z0-9-]{1,64}$/u

const HARNESS_SKIP_REASONS = new Set<JobSkipReason>([
  "enabled",
  "schedule-enabled",
  "harness-lock-held",
  "no-active-canary",
  "no-policy-midflight",
  "no-meta-trialing",
  "sealed-epochs",
  "distinct-epochs",
  "dev-signals",
  "holdout-signals",
  "holdout-unused",
  "dev-sample-floor",
  "holdout-sample-floor",
  "harness-skipped",
])

export function harnessSkipReasonFromSlug(slug: string | undefined): JobSkipReason {
  if (slug && SAFE_REASON.test(slug) && HARNESS_SKIP_REASONS.has(slug as JobSkipReason)) {
    return slug as JobSkipReason
  }
  return "harness-skipped"
}

const WALLET_EVIDENCE_JOBS = new Set<JobName>([
  "wallet-discovery",
  "wallet-scan-solana",
  "wallet-scan-evm",
])

const HOST_GATED_JOBS = new Set<JobName>([
  "research",
  "review",
  "wallet-discovery",
  "wallet-scan-solana",
  "wallet-scan-evm",
  "chart-sweep",
  "watchlist-scan",
  "fomo-trader-sync",
  "fomo-signal-scan",
  "discord-wallet-signal-scan",
  "delivery-retry",
  "telegram-digest",
  "farcaster-scan",
  "fc-source-review",
])

export function isHostGatedJob(job: JobName): boolean {
  return HOST_GATED_JOBS.has(job)
}

export function countActiveWatchlistSubjects(agentRoot: string): number {
  const state = new StateStore(join(agentRoot, "state"))
  return state.loadWatchlist().entries.filter((entry) => (
    entry.status === "tracking" || entry.status === "watching"
  )).length
}

export function countWalletSupportedWatchlistSubjects(agentRoot: string): number {
  const state = new StateStore(join(agentRoot, "state"))
  return state.loadWatchlist().entries.filter((entry) => {
    if (entry.status !== "tracking" && entry.status !== "watching") return false
    const chain = getChain(entry.identity.chain)
    return Boolean(chain && chain.walletTracking !== "unsupported")
  }).length
}

function evaluateWalletPreconditions(
  job: JobName,
  state: StateStore,
  agentRoot: string,
): JobPreconditionResult | undefined {
  if (!WALLET_EVIDENCE_JOBS.has(job)) return undefined
  if (job === "wallet-discovery") {
    if (countActiveWatchlistSubjects(agentRoot) === 0) {
      return { skip: true, reason: "no-active-watchlist-subjects" }
    }
    if (countWalletSupportedWatchlistSubjects(agentRoot) === 0) {
      return { skip: true, reason: "no-wallet-supported-subjects" }
    }
    return undefined
  }

  const family = job === "wallet-scan-solana" ? "solana" : "evm"
  const hasEligibleWallet = state.loadWallets().wallets.some((wallet) => {
    if (!["candidate", "tracking-probation", "tracking"].includes(wallet.status)) return false
    const tracking = getChain(wallet.chain)?.walletTracking
    return family === "solana"
      ? tracking === "helius"
      : tracking === "infura" || tracking === "robinhood-public"
  })
  if (hasEligibleWallet) return undefined
  return {
    skip: true,
    reason: family === "solana" ? "no-eligible-solana-wallets" : "no-eligible-evm-wallets",
  }
}

async function evaluateResearchPreconditions(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  nowIso: string
}>): Promise<JobPreconditionResult | undefined> {
  const config = loadConfig()
  const state = new StateStore(join(args.agentRoot, "state"))
  const expired = expireQueue(state.loadResearchQueue(), args.nowIso)
  const queue = expired.next
  // Persist expiry + discovery log; peek dequeue only (runJob claims under lock)
  if (expired.expired.length > 0) {
    await state.saveResearchQueue(queue)
    await appendQueueSweepDiscoveryLogs(
      archiveLayout(args.archiveRoot),
      expired.expired,
      "expired",
      args.nowIso,
    )
  }
  const dequeued = dequeueDue(queue, args.nowIso, 1, config.research.daily_cap)
  if (dequeued.due[0]) return undefined
  const completed = todayCompletedCount(queue, args.nowIso.slice(0, 10))
  const pending = queue.entries.some((entry) => entry.status === "pending")
  if (completed >= config.research.daily_cap) {
    return { skip: true, reason: "daily-cap", details: { completed, pending } }
  }
  if (pending) {
    return { skip: true, reason: "queue-pending", details: { completed, pending } }
  }
  return { skip: true, reason: "queue-empty", details: { completed, pending } }
}

export async function evaluateJobPreconditions(args: Readonly<{
  job: JobName
  agentRoot: string
  archiveRoot: string
  nowIso: string
  dryCollect?: boolean
}>): Promise<JobPreconditionResult | undefined> {
  getJob(args.job)
  if (!isHostGatedJob(args.job)) return undefined

  if (!existsSync(join(args.agentRoot, "state"))) {
    return { skip: true, reason: "not-initialized" }
  }

  const state = new StateStore(join(args.agentRoot, "state"))

  if (args.job === "research") {
    return evaluateResearchPreconditions({
      agentRoot: args.agentRoot,
      archiveRoot: args.archiveRoot,
      nowIso: args.nowIso,
    })
  }

  if (args.job === "review") {
    let lookbackDays = 7
    let maxReports = 30
    try {
      const cfg = loadConfig()
      lookbackDays = cfg.review.lookback_days
      maxReports = cfg.review.max_reports
    } catch {
      // operator config absent — defaults suffice for prerequisite gate
    }
    const reviewPrereqs = await evaluateReviewPrerequisites({
      agentRoot: args.agentRoot,
      archiveRoot: args.archiveRoot,
      nowIso: args.nowIso,
      lookbackDays,
      maxReports,
    })
    if (reviewPrereqs.skipReason) {
      return {
        skip: true,
        reason: "no-review-scope",
        details: {
          sealedReports: reviewPrereqs.sealedReports.length,
          pendingAlpha: reviewPrereqs.pendingAlphaPaths.length,
          watchlistSubjects: reviewPrereqs.watchlistSubjects,
          healthWarnings: reviewPrereqs.health?.warnings.length ?? 0,
        },
      }
    }
    return undefined
  }

  if (WALLET_EVIDENCE_JOBS.has(args.job)) {
    return evaluateWalletPreconditions(args.job, state, args.agentRoot)
  }

  if (args.job === "chart-sweep" || args.job === "watchlist-scan") {
    const subjects = countActiveWatchlistSubjects(args.agentRoot)
    if (subjects === 0) {
      return { skip: true, reason: "no-active-watchlist-subjects", details: { subjects } }
    }
  }

  if (args.job === "discord-wallet-signal-scan") {
    let cfg
    try {
      cfg = loadConfig()
    } catch {
      return { skip: true, reason: "wallet-signals-disabled" }
    }
    if (!cfg.chat.discord.wallet_signals.enabled) {
      return { skip: true, reason: "wallet-signals-disabled" }
    }
    if (
      !cfg.chat.discord.enabled
      || !cfg.chat.discord.guild_id
      || cfg.chat.discord.wallet_signals.channel_ids.length < 1
    ) {
      return { skip: true, reason: "wallet-signals-misconfigured" }
    }
    if (!process.env["DISCORD_RESEARCH_BOT_TOKEN"]?.trim()) {
      return { skip: true, reason: "discord-token-missing" }
    }
  }

  if (args.job === "fomo-trader-sync" || args.job === "fomo-signal-scan") {
    let cfg
    try {
      cfg = loadConfig()
    } catch {
      return { skip: true, reason: "fomo-disabled" }
    }
    if (!cfg.fomo.enabled) {
      return { skip: true, reason: "fomo-disabled" }
    }
    if (args.job === "fomo-trader-sync" && !cfg.fomo.trader_sync.enabled) {
      return { skip: true, reason: "fomo-capability-gate", details: { capability: "trader_sync" } }
    }
    if (args.job === "fomo-signal-scan" && !cfg.fomo.signal_scan.enabled) {
      return { skip: true, reason: "fomo-capability-gate", details: { capability: "signal_scan" } }
    }
    if (!fomoSessionExists()) {
      return { skip: true, reason: "fomo-missing-session" }
    }
    if (!providerGateAllowsSchedule(args.archiveRoot)) {
      return { skip: true, reason: "fomo-provider-gate" }
    }
  }

  if (args.job === "delivery-retry") {
    const routerUrl = process.env["TRENCHCOAT_ROUTER_URL"]?.trim()
    const hmacKey = process.env["TRENCHCOAT_ROUTER_HMAC_KEY"]?.trim()
    if (!routerUrl || !hmacKey) {
      return { skip: true, reason: "router-unconfigured" }
    }
    const layout = await ensureArchive(args.archiveRoot)
    const { listIngressPending } = await import("./delivery.js")
    const pending = listIngressPending(layout, args.nowIso)
    if (pending.length === 0) {
      return { skip: true, reason: "no-pending-ingress", details: { pending: 0 } }
    }
  }

  if (args.job === "farcaster-scan" || args.job === "fc-source-review") {
    let enabled = false
    try {
      enabled = loadConfig().farcaster.enabled
    } catch {
      enabled = false
    }
    if (!enabled) {
      return { skip: true, reason: "farcaster-disabled" }
    }
  }

  if (args.job === "telegram-digest") {
    let enabled = false
    try {
      enabled = loadConfig().broadcast.telegram_digest.enabled
    } catch {
      enabled = false
    }
    if (!enabled) {
      return { skip: true, reason: "telegram-digest-disabled" }
    }
  }

  return undefined
}

function boundedDetails(
  details: Readonly<Record<string, string | number | boolean>> | undefined,
): Record<string, string | number | boolean> | undefined {
  if (!details) return undefined
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(details)) {
    if (!/^[a-zA-Z0-9_]{1,40}$/u.test(key)) continue
    if (typeof value === "string") {
      out[key] = value.slice(0, 200)
    } else {
      out[key] = value
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function skipLedgerPath(archiveRoot: string, job: JobName): string {
  if (!SAFE_JOB.test(job)) throw new Error(`unsafe job name for skip ledger: ${job}`)
  return join(archiveRoot, "skips", `${job}.jsonl`)
}

export async function recordJobSkip(args: Readonly<{
  job: JobName
  reason: JobSkipReason
  details?: Readonly<Record<string, string | number | boolean>>
  archiveRoot: string
  skippedAt?: string
}>): Promise<void> {
  if (!SAFE_JOB.test(args.job)) throw new Error(`unsafe job name: ${args.job}`)
  if (!SAFE_REASON.test(args.reason)) throw new Error(`unsafe skip reason: ${args.reason}`)
  const skippedAt = args.skippedAt ?? systemClock.nowIso()
  const details = boundedDetails(args.details)
  log.info("job skipped", {
    job: args.job,
    reason: args.reason,
    ...(details ?? {}),
  })
  await ensureArchive(args.archiveRoot)
  const path = skipLedgerPath(args.archiveRoot, args.job)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  await appendJsonl(path, {
    schema: 1,
    job: args.job,
    reason: args.reason,
    skippedAt,
    ...(details ? { details } : {}),
  })
}

/** Read-only precondition probe for launchd / CLI. Does not acquire the workspace lock. */
export async function precheckJob(args: Readonly<{
  job: JobName
  agentRoot: string
  archiveRoot: string
  nowIso?: string
}>): Promise<Readonly<{
  job: JobName
  skip: boolean
  reason?: JobSkipReason
  details?: Readonly<Record<string, string | number | boolean>>
}>> {
  getJob(args.job)
  if (!existsSync(join(args.agentRoot, "state"))) {
    return { job: args.job, skip: true, reason: "not-initialized" }
  }
  const result = await evaluateJobPreconditions({
    job: args.job,
    agentRoot: args.agentRoot,
    archiveRoot: args.archiveRoot,
    nowIso: args.nowIso ?? systemClock.nowIso(),
  })
  if (!result) return { job: args.job, skip: false }
  return {
    job: args.job,
    skip: true,
    reason: result.reason,
    ...(result.details ? { details: result.details } : {}),
  }
}

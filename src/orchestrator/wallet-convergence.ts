import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ensureArchive, writeJsonRecord } from "../lib/archive.js"
import { loadConfig } from "../lib/config.js"
import { StateStore } from "../lib/state.js"
import { Outbox } from "../lib/outbox.js"
import { systemClock } from "../lib/clock.js"
import { sha256Json } from "../lib/canonical-json.js"
import { enqueueResearch } from "../lib/research-queue.js"
import { isNativeOrWrapMint } from "../lib/native-mints.js"
import { renderWalletConvergenceLine } from "../lib/router-contract.js"
import {
  WalletBuyOutcomeSchema,
  type ResearchQueueEntry,
  type RouterEvent,
  type WalletBuyOutcome,
  type WalletRunnersFile,
} from "../contracts/schemas.js"
import { deriveWalletBuyConvergence } from "../wallets/convergence.js"
import { scheduleResearchDrain } from "./research-drain.js"

export type WalletConvergenceReport = Readonly<{
  runId: string
  status: "completed" | "skipped" | "disabled"
  signals: number
  alertsStaged: number
  researchEnqueued: number
  skippedReasons: readonly string[]
}>

function dayKey(iso: string): string {
  return iso.slice(0, 10)
}

function rolloverCount(
  current: WalletRunnersFile["alertsToday"],
  day: string,
): { day: string; count: number } {
  if (!current || current.day !== day) return { day, count: 0 }
  return current
}

function loadRecentOutcomes(archiveRoot: string, maxFiles = 48): WalletBuyOutcome[] {
  const dir = join(archiveRoot, "outcomes")
  if (!existsSync(dir)) return []
  const names = readdirSync(dir)
    .filter((n) => n.startsWith("wallet-buy-") && n.endsWith(".json"))
    .sort()
    .slice(-maxFiles)
  const out: WalletBuyOutcome[] = []
  for (const name of names) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as { outcomes?: unknown[] }
      for (const entry of raw.outcomes ?? []) {
        const parsed = WalletBuyOutcomeSchema.safeParse(entry)
        if (parsed.success) out.push(parsed.data)
      }
    } catch {
      continue
    }
  }
  return out
}

function expiryIso(nowIso: string, days: number): string {
  return new Date(Date.parse(nowIso) + days * 86_400_000).toISOString()
}

export async function runWalletConvergence(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  runId: string
  family: "solana" | "evm"
  newOutcomes?: readonly WalletBuyOutcome[]
  blockExternalEffects?: boolean
}>): Promise<WalletConvergenceReport> {
  const config = loadConfig()
  const conv = config.wallets.convergence
  if (!conv.enabled) {
    return {
      runId: args.runId,
      status: "disabled",
      signals: 0,
      alertsStaged: 0,
      researchEnqueued: 0,
      skippedReasons: ["disabled"],
    }
  }

  const store = new StateStore(join(args.agentRoot, "state"))
  const archive = await ensureArchive(args.archiveRoot)
  const nowIso = systemClock.nowIso()
  const day = dayKey(nowIso)
  let runners = store.loadWalletRunners()
  const alertsToday = rolloverCount(runners.alertsToday, day)
  const enqueuesToday = rolloverCount(runners.enqueuesToday, day)

  const archived = loadRecentOutcomes(args.archiveRoot)
  const byEvent = new Map<string, WalletBuyOutcome>()
  for (const o of [...archived, ...(args.newOutcomes ?? [])]) {
    byEvent.set(o.eventId, o)
  }
  const outcomes = [...byEvent.values()]

  const signals = deriveWalletBuyConvergence(outcomes, {
    minWallets: conv.min_wallets,
    windowMinutes: conv.window_minutes,
    maxTokenAgeHours: conv.max_token_age_hours,
    nowIso,
    nativeOrWrap: (token) => isNativeOrWrapMint(token),
    hash: (payload) => sha256Json(payload as never),
  })

  const skippedReasons: string[] = []
  let alertsStaged = 0
  let researchEnqueued = 0
  const alerted = new Set(runners.alertedConvergenceIds)
  const enqueued = new Set(runners.enqueuedConvergenceIds)
  const cooldown = { ...runners.cooldownUntilByToken }
  let queue = store.loadResearchQueue()
  const watchlist = store.loadWatchlist()
  const onWatchlist = new Set(
    watchlist.entries
      .filter((e) => e.status === "tracking" || e.status === "watching")
      .map((e) => `${e.identity.chain}:${e.identity.tokenAddress.toLowerCase()}`),
  )

  const outbox = new Outbox(join(archive.routerOutbox, args.runId))

  for (const signal of signals) {
    const tokenKey = `${signal.chain}:${signal.tokenAddress.toLowerCase()}`
    if (onWatchlist.has(tokenKey)) {
      skippedReasons.push(`${tokenKey}:on-watchlist`)
      continue
    }
    const coolUntil = cooldown[tokenKey]
    if (coolUntil && Date.parse(coolUntil) > Date.parse(nowIso)) {
      skippedReasons.push(`${tokenKey}:cooldown`)
      continue
    }

    if (!alerted.has(signal.convergenceId) && alertsToday.count < conv.max_alerts_per_day) {
      if (!args.blockExternalEffects && !conv.shadow_mode) {
        const text = renderWalletConvergenceLine({
          chain: signal.chain,
          tokenAddress: signal.tokenAddress,
          walletCount: signal.walletIds.length,
          windowMinutes: conv.window_minutes,
        })
        const event: RouterEvent = {
          schema: 1,
          eventId: signal.convergenceId,
          occurredAt: nowIso,
          runId: args.runId,
          type: "wallet.convergence",
          severity: "info",
          text,
          refs: ["state/wallet-runners.json"],
          walletConvergence: {
            chain: signal.chain as never,
            tokenAddress: signal.tokenAddress,
            walletIds: [...signal.walletIds],
            windowMinutes: conv.window_minutes,
            firstBuyAt: signal.firstBuyAt,
            label: "UNVERIFIED WALLET CONVERGENCE",
          },
        }
        await outbox.stage(event)
        alertsStaged += 1
        alertsToday.count += 1
      }
      alerted.add(signal.convergenceId)
      cooldown[tokenKey] = new Date(
        Date.parse(nowIso) + conv.cooldown_hours * 3_600_000,
      ).toISOString()
    }

    if (!enqueued.has(signal.convergenceId) && enqueuesToday.count < conv.max_enqueues_per_day) {
      if (!conv.shadow_mode) {
        const entry: ResearchQueueEntry = {
          schema: 1,
          queueId: `rq-wconv-${signal.convergenceId.slice("sha256:".length, 24)}`,
          subject: `${signal.chain}:${signal.tokenAddress}`,
          chain: signal.chain as ResearchQueueEntry["chain"],
          tokenAddress: signal.tokenAddress,
          priority: 70,
          firstSeen: signal.firstBuyAt,
          enqueuedAt: nowIso,
          enqueuedBy: `wallet-scan-${args.family}`,
          trigger: "wallet-convergence",
          expiresAt: expiryIso(nowIso, 3),
          provenance: [
            `wallet:convergence:${signal.chain}:${signal.tokenAddress}:${signal.walletIds.join(",")}`,
          ],
          clusterCount: signal.walletIds.length,
          security: { status: "pending", flags: [] },
          status: "pending",
          reason: `wallet convergence: ${signal.walletIds.length} tracked wallets in ${conv.window_minutes}m`,
          resolution: "pending",
        }
        queue = enqueueResearch(queue, entry, config.research.daily_cap)
        researchEnqueued += 1
        enqueuesToday.count += 1
      }
      enqueued.add(signal.convergenceId)
    }
  }

  runners = {
    ...runners,
    alertedConvergenceIds: [...alerted].slice(-10_000),
    enqueuedConvergenceIds: [...enqueued].slice(-10_000),
    cooldownUntilByToken: cooldown,
    alertsToday,
    enqueuesToday,
  }

  if (!conv.shadow_mode) {
    await store.saveWalletRunners(runners)
    if (researchEnqueued > 0) {
      await store.saveResearchQueue(queue)
      scheduleResearchDrain({
        agentRoot: args.agentRoot,
        archiveRoot: args.archiveRoot,
      })
    }
  }

  await writeJsonRecord(join(archive.wallets, `${args.runId}-convergence.json`), {
    schema: 1,
    runId: args.runId,
    family: args.family,
    shadowMode: conv.shadow_mode,
    signals,
    alertsStaged,
    researchEnqueued,
    skippedReasons,
  } as never)

  return {
    runId: args.runId,
    status: "completed",
    signals: signals.length,
    alertsStaged,
    researchEnqueued,
    skippedReasons,
  }
}

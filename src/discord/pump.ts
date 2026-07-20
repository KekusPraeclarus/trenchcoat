import { systemClock } from "../lib/clock.js"
import { log } from "../lib/log.js"
import { WorkspaceLock } from "../lib/lock.js"
import { discordLayout } from "./paths.js"
import { createDiscordStore, pruneOldRequests, rolloverQuotaDay } from "./store.js"
import {
  countActiveForUser,
  DISCORD_ERRORS,
  quotaAllows,
  recountDailyQuota,
} from "./quota.js"
import type { DiscordRequestRecord } from "./schemas.js"
import { runDiscordResearch } from "./research-run.js"
import {
  createDiscordRestClient,
  DISCORD_RESEARCH_STARTED_EMOJI,
} from "./bot-client.js"
import {
  deliverResearchReply,
  deliverTerminalError,
  mapResearchError,
} from "./delivery.js"
import { subscribeAfterResearch } from "./watchlist.js"
import { promoteDiscordTrackToMain } from "./promote-to-main.js"
import { tokenKey } from "./schemas.js"
import { loadConfig } from "../lib/config.js"
import { extractResearchBrief } from "./research-brief.js"

async function withStoreLockRetry<T>(
  lockPath: string,
  fn: () => Promise<T>,
  attempts = 40,
): Promise<{ ok: true; value: T } | { ok: false }> {
  for (let i = 0; i < attempts; i += 1) {
    const lock = new WorkspaceLock(lockPath)
    if (lock.tryAcquire()) {
      try {
        return { ok: true, value: await fn() }
      } finally {
        lock.release()
      }
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  return { ok: false }
}

/** On listener start only: re-queue orphaned running work once */
export async function reclaimOrphanedDiscordRequests(): Promise<number> {
  const layout = discordLayout()
  const store = createDiscordStore(layout)
  const locked = await withStoreLockRetry(layout.lock, async () => {
    const file = store.loadRequests()
    let n = 0
    for (const req of file.requests) {
      if (req.status === "running") {
        req.status = "queued"
        req.updatedAt = systemClock.nowIso()
        n += 1
      }
    }
    if (n > 0) await store.saveRequests(file)
    return n
  })
  return locked.ok ? locked.value : 0
}

export async function acceptDiscordRequest(args: Readonly<{
  guildId: string
  channelId: string
  messageId: string
  userId: string
  subject: string
  chainHint?: string
  tokenHint?: string
}>): Promise<
  | { accepted: true; request: DiscordRequestRecord }
  | { accepted: false; terminal: string }
  | { duplicate: true; request: DiscordRequestRecord }
> {
  const config = loadConfig()
  const layout = discordLayout()
  const store = createDiscordStore(layout)

  const locked = await withStoreLockRetry(layout.lock, async () => {
    const nowIso = systemClock.nowIso()
    let file = store.loadRequests()
    file = pruneOldRequests(file, nowIso)
    file = rolloverQuotaDay(file, nowIso)

    const existing = file.requests.find((r) => r.requestId === args.messageId)
    if (existing) return { duplicate: true as const, request: existing }

    const activeCount = countActiveForUser(file, args.userId)
    if (activeCount >= config.chat.discord.max_active_per_user) {
      return { accepted: false as const, terminal: DISCORD_ERRORS.ACTIVE }
    }

    const quota = quotaAllows(file, args.userId, config, nowIso)
    file = quota.file
    if (!quota.ok) {
      return {
        accepted: false as const,
        terminal: quota.reason === "server"
          ? DISCORD_ERRORS.SERVER_CAP
          : DISCORD_ERRORS.USER_CAP,
      }
    }

    const request: DiscordRequestRecord = {
      requestId: args.messageId,
      guildId: args.guildId,
      channelId: args.channelId,
      messageId: args.messageId,
      userId: args.userId,
      subject: args.subject.slice(0, 256),
      ...(args.chainHint ? { chain: args.chainHint as DiscordRequestRecord["chain"] } : {}),
      ...(args.tokenHint ? { tokenAddress: args.tokenHint } : {}),
      status: "queued",
      createdAt: nowIso,
      updatedAt: nowIso,
      quotaDay: file.quotaDay,
      deliveredPartKeys: [],
    }
    file.requests.push(request)
    file = recountDailyQuota(file, nowIso)
    await store.saveRequests(file)
    return { accepted: true as const, request }
  })

  if (!locked.ok) {
    return { accepted: false, terminal: DISCORD_ERRORS.BUSY }
  }
  return locked.value
}

export async function processNextDiscordRequest(args: Readonly<{
  repoRoot: string
  token: string
}>): Promise<"idle" | "processed" | "busy"> {
  const layout = discordLayout()
  const store = createDiscordStore(layout)
  const config = loadConfig()

  // Hold worker for the whole unit of work so concurrent pumpLoops stay queued
  const worker = new WorkspaceLock(layout.workerLock)
  if (!worker.tryAcquire()) return "busy"

  try {
    const claimed = await withStoreLockRetry(layout.lock, async () => {
      const file = store.loadRequests()
      const queued = file.requests
        .filter((r) => r.status === "queued")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      const request = queued[0]
      if (!request) return undefined

      request.status = "running"
      request.updatedAt = systemClock.nowIso()
      const idx = file.requests.findIndex((r) => r.requestId === request.requestId)
      file.requests[idx] = request
      await store.saveRequests(file)
      return request
    })

    if (!claimed.ok) return "busy"
    const request = claimed.value
    if (!request) return "idle"

    const client = createDiscordRestClient(args.token)
    try {
      await client.addReaction({
        channelId: request.channelId,
        messageId: request.messageId,
        emoji: DISCORD_RESEARCH_STARTED_EMOJI,
      })
    } catch (error) {
      log.warn("discord research-start reaction failed", {
        messageId: request.messageId,
        error: error instanceof Error ? error.message : "unknown",
      })
    }

    const result = await runDiscordResearch({
      repoRoot: args.repoRoot,
      model: config.chat.discord.model,
      input: {
        subject: request.subject,
        ...(request.chain ? { chainHint: request.chain } : {}),
        ...(request.tokenAddress ? { tokenHint: request.tokenAddress } : {}),
        requestId: request.requestId,
        provenance: ["discord:research"],
      },
    })

    if (result.status === "ambiguous" || result.status === "rejected") {
      await deliverTerminalError({
        client,
        store,
        request,
        error: mapResearchError(result.error),
      })
      return "processed"
    }
    if (result.status === "failed") {
      await deliverTerminalError({
        client,
        store,
        request,
        error: DISCORD_ERRORS.FAILED,
      })
      return "processed"
    }

    // Deliver research only — watch subscribe / main promote stay host-side silent
    const reportText = result.reportText ?? ""

    const replyStarted = Date.now()
    const delivered = await deliverResearchReply({
      client,
      store,
      request,
      text: reportText,
    })
    log.info("discord research stage", {
      stage: "reply",
      requestId: request.requestId,
      ms: Date.now() - replyStarted,
      status: delivered.ok ? "ok" : "failed",
    })

    if (!delivered.ok) {
      await deliverTerminalError({ client, store, request, error: DISCORD_ERRORS.FAILED })
      return "processed"
    }

    if (result.identity && result.subscribeAllowed && result.baseline) {
      const subscribeStarted = Date.now()
      try {
        const baseline = result.baseline
        const researchBrief = reportText ? extractResearchBrief(reportText) : undefined
        const subLock = await withStoreLockRetry(layout.lock, async () => {
          let watch = store.loadWatchlist()
          const sub = subscribeAfterResearch({
            file: watch,
            identity: result.identity!,
            guildId: request.guildId,
            userId: request.userId,
            channelId: request.channelId,
            messageId: request.messageId,
            nowIso: systemClock.nowIso(),
            baseline,
            ...(researchBrief ? { researchBrief } : {}),
            securityHardFail: Boolean(result.securityHardFail),
          })
          watch = sub.file
          if (!sub.subscribed && sub.capacityReason) {
            return { capacity: true as const }
          }
          if (sub.subscribed) {
            await store.saveWatchlist(watch)
            const obs = store.loadObservations()
            obs.byToken[tokenKey(result.identity!.chain, result.identity!.tokenAddress)] = baseline
            await store.saveObservations(obs)
          }
          return { capacity: false as const }
        })
        log.info("discord research stage", {
          stage: "subscription",
          requestId: request.requestId,
          ms: Date.now() - subscribeStarted,
          status: subLock.ok
            ? (subLock.value.capacity ? "capacity" : "ok")
            : "lock-busy",
        })
      } catch (error) {
        log.warn("discord watch baseline failed", {
          requestId: request.requestId,
          error: error instanceof Error ? error.message : "unknown",
        })
      }
    }

    if (
      result.mainTrackEligible
      && result.identity
      && result.runId
      && result.security
      && !result.securityHardFail
    ) {
      const promoteStarted = Date.now()
      try {
        const promoted = await promoteDiscordTrackToMain({
          discordAgentRoot: layout.agent,
          discordArchiveRoot: layout.archive,
          runId: result.runId,
          identity: result.identity,
          security: result.security,
        })
        log.info("discord research stage", {
          stage: "main-promote",
          requestId: request.requestId,
          ms: Date.now() - promoteStarted,
          status: promoted.promoted ? "ok" : "skipped",
          ...(promoted.reason ? { reason: promoted.reason } : {}),
        })
      } catch (error) {
        log.warn("discord main promote failed", {
          requestId: request.requestId,
          error: error instanceof Error ? error.message : "unknown",
        })
      }
    }

    return "processed"
  } finally {
    worker.release()
  }
}

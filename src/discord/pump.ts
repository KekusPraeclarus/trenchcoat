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
import { subscribeAfterResearch, discordWatchSubscribeEligible } from "./watchlist.js"
import { promoteDiscordTrackToMain } from "./promote-to-main.js"
import { tokenKey } from "./schemas.js"
import { loadConfig } from "../lib/config.js"
import { extractResearchBrief } from "./research-brief.js"
import {
  enqueueTrackingMatchBatch,
  hashTrackingCandidates,
} from "./tracking-hooks.js"

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
  origin?: "user" | "tracking"
  trackingPingMessageId?: string
  trackingId?: string
  trackingDeliveryId?: string
  trackingShortLabel?: string
  trackingQualificationSource?: "main-track" | "three-mention-review"
}>): Promise<
  | { accepted: true; request: DiscordRequestRecord }
  | { accepted: false; terminal: string }
  | { duplicate: true; request: DiscordRequestRecord }
> {
  const config = loadConfig()
  const layout = discordLayout()
  const store = createDiscordStore(layout)
  const origin = args.origin ?? "user"

  const locked = await withStoreLockRetry(layout.lock, async () => {
    const nowIso = systemClock.nowIso()
    let file = store.loadRequests()
    file = pruneOldRequests(file, nowIso)
    file = rolloverQuotaDay(file, nowIso)

    const existing = file.requests.find((r) => r.requestId === args.messageId)
    if (existing) return { duplicate: true as const, request: existing }

    if (origin === "tracking") {
      const dupSubject = file.requests.find((r) => (
        r.origin === "tracking"
        && r.subject.toLowerCase() === args.subject.toLowerCase()
        && (r.status === "queued" || r.status === "running" || r.status === "completed")
        && r.quotaDay === file.quotaDay
      ))
      if (dupSubject) return { duplicate: true as const, request: dupSubject }
    } else {
      const activeCount = countActiveForUser(file, args.userId)
      if (activeCount >= config.chat.discord.max_active_per_user) {
        return { accepted: false as const, terminal: DISCORD_ERRORS.ACTIVE }
      }
    }

    const quota = quotaAllows(file, args.userId, config, nowIso, {
      bypassUserCap: origin === "tracking",
    })
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
      origin,
      ...(args.trackingPingMessageId
        ? { trackingPingMessageId: args.trackingPingMessageId }
        : {}),
      ...(args.trackingId ? { trackingId: args.trackingId } : {}),
      ...(args.trackingDeliveryId
        ? { trackingDeliveryId: args.trackingDeliveryId }
        : {}),
      ...(args.trackingShortLabel
        ? { trackingShortLabel: args.trackingShortLabel.slice(0, 64) }
        : {}),
      ...(args.trackingQualificationSource
        ? { trackingQualificationSource: args.trackingQualificationSource }
        : {}),
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
    const isTrackingOrigin = request.origin === "tracking"

    if (!isTrackingOrigin) {
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

    if (isTrackingOrigin) {
      await finalizeTrackingOriginResearch({
        store,
        request,
        result,
        repoRoot: args.repoRoot,
        token: args.token,
      })
      return "processed"
    }

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

    // Idea-tracking match against completed Discord research (never fails the request)
    if (reportText) {
      try {
        const digest = JSON.stringify([{
          provenance: `discord-research:${request.requestId}`,
          text: reportText.slice(0, 2_000),
        }])
        await enqueueTrackingMatchBatch({
          sourceKind: "discord-research",
          runId: result.runId ?? `discord-${request.requestId}`,
          snapshotHash: hashTrackingCandidates(digest),
          candidateDigest: digest,
          researchSummary: reportText.slice(0, 8_000),
          researchSubject: request.subject,
          ...(result.identity
            ? {
              researchChain: result.identity.chain,
              researchTokenAddress: result.identity.tokenAddress,
            }
            : {}),
          mainTrackEligible: Boolean(result.mainTrackEligible),
        })
      } catch (error) {
        log.warn("discord tracking enqueue after research failed", {
          requestId: request.requestId,
          error: error instanceof Error ? error.message : "unknown",
        })
      }
    }

    const watchBaseline = result.baseline
    const watchIdentity = result.identity
    if (
      watchBaseline
      && watchIdentity
      && discordWatchSubscribeEligible({
        hasIdentity: true,
        hasBaseline: true,
        subscribeAllowed: result.subscribeAllowed,
        mainTrackEligible: result.mainTrackEligible,
        securityHardFail: result.securityHardFail,
      })
    ) {
      const subscribeStarted = Date.now()
      try {
        const researchBrief = reportText ? extractResearchBrief(reportText) : undefined
        const subLock = await withStoreLockRetry(layout.lock, async () => {
          let watch = store.loadWatchlist()
          const sub = subscribeAfterResearch({
            file: watch,
            identity: watchIdentity,
            guildId: request.guildId,
            userId: request.userId,
            channelId: request.channelId,
            messageId: request.messageId,
            nowIso: systemClock.nowIso(),
            baseline: watchBaseline,
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
            obs.byToken[tokenKey(watchIdentity.chain, watchIdentity.tokenAddress)] = watchBaseline
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

async function finalizeTrackingOriginResearch(args: Readonly<{
  store: ReturnType<typeof createDiscordStore>
  request: DiscordRequestRecord
  result: Awaited<ReturnType<typeof runDiscordResearch>>
  repoRoot: string
  token: string
}>): Promise<void> {
  const { store, request, result } = args
  const layout = discordLayout()
  const nowIso = systemClock.nowIso()
  const deliveryId = request.trackingDeliveryId
  const qualificationSource = request.trackingQualificationSource ?? "main-track"

  // Mark the research request completed silently (no Discord error/reply)
  await withStoreLockRetry(layout.lock, async () => {
    let file = store.loadRequests()
    const idx = file.requests.findIndex((r) => r.requestId === request.requestId)
    if (idx < 0) return
    file.requests[idx] = {
      ...file.requests[idx]!,
      status: result.status === "completed" ? "completed" : "failed",
      updatedAt: nowIso,
      ...(result.runId ? { runId: result.runId } : {}),
      ...(result.status !== "completed"
        ? { terminalError: (result.error ?? result.status).slice(0, 280) }
        : {}),
    }
    file = recountDailyQuota(file, nowIso)
    await store.saveRequests(file)
  })

  if (!deliveryId) return

  const reportText = result.reportText ?? ""
  const identity = result.identity
  const mainTrackOk = Boolean(result.mainTrackEligible)
  const threeMentionOk = qualificationSource === "three-mention-review"
    && result.status === "completed"
    && Boolean(identity)
    && reportText.trim().length > 0

  let shouldAlert = false
  let securityWarning: string | undefined

  if (result.status === "completed" && identity && reportText.trim()) {
    if (mainTrackOk) {
      shouldAlert = true
    } else if (threeMentionOk) {
      shouldAlert = true
      if (result.securityHardFail || result.security?.hardFail) {
        const flags = (result.security?.flags ?? []).slice(0, 8).join(", ")
        securityWarning = [
          `status=${result.security?.status ?? "hard-fail"}`,
          flags ? `flags=${flags}` : undefined,
        ].filter(Boolean).join("; ")
      }
    }
  }

  await withStoreLockRetry(layout.lock, async () => {
    const file = store.loadTracking()
    const idx = file.trackingDeliveries.findIndex((d) => d.deliveryId === deliveryId)
    if (idx < 0) return
    const current = file.trackingDeliveries[idx]!
    if (current.status === "delivered" || current.status === "terminal") return

    if (shouldAlert) {
      file.trackingDeliveries[idx] = {
        ...current,
        status: "qualified-pending",
        researchSummary: reportText.slice(0, 8_000),
        shortLabel: request.trackingShortLabel ?? current.shortLabel ?? "tracked idea",
        qualificationSource,
        ...(identity
          ? {
            chain: identity.chain as typeof current.chain,
            tokenAddress: identity.tokenAddress.toLowerCase(),
            subject: `${identity.chain}:${identity.tokenAddress}`,
            normalizedSubject: `${identity.chain}:${identity.tokenAddress.toLowerCase()}`,
          }
          : {}),
        ...(securityWarning ? { securityWarning: securityWarning.slice(0, 500) } : {}),
        updatedAt: nowIso,
        lastError: undefined,
      }
    } else {
      // Initial non-qualification → wait for three later unique mentions
      file.trackingDeliveries[idx] = {
        ...current,
        status: "awaiting-mentions",
        qualificationSource: undefined,
        researchEnqueued: true,
        ...(identity
          ? {
            chain: identity.chain as typeof current.chain,
            tokenAddress: identity.tokenAddress.toLowerCase(),
            subject: `${identity.chain}:${identity.tokenAddress}`,
            normalizedSubject: `${identity.chain}:${identity.tokenAddress.toLowerCase()}`,
          }
          : {}),
        updatedAt: nowIso,
        lastError: (result.error ?? result.mainTrackSkipReason ?? "not-solid").slice(0, 280),
      }
    }
    await store.saveTracking(file)
  })

  if (shouldAlert) {
    try {
      const { deliverTrackingAlert } = await import("./tracking-delivery.js")
      const { createDiscordRestClient } = await import("./bot-client.js")
      const delivery = store.loadTracking().trackingDeliveries
        .find((d) => d.deliveryId === deliveryId)
      if (delivery?.status === "qualified-pending") {
        await deliverTrackingAlert({
          client: createDiscordRestClient(args.token),
          store,
          delivery,
          nowIso,
        })
      }
    } catch (error) {
      log.warn("tracking alert delivery after research failed", {
        deliveryId,
        error: error instanceof Error ? error.message : "unknown",
      })
    }
  }

  // Watch subscribe requires validated track verdict — never bypassed by three-mention path
  const trackWatchBaseline = result.baseline
  const trackWatchIdentity = result.identity
  if (
    result.status === "completed"
    && trackWatchBaseline
    && trackWatchIdentity
    && discordWatchSubscribeEligible({
      hasIdentity: true,
      hasBaseline: true,
      subscribeAllowed: result.subscribeAllowed,
      mainTrackEligible: result.mainTrackEligible,
      securityHardFail: result.securityHardFail,
    })
  ) {
    try {
      const researchBrief = reportText ? extractResearchBrief(reportText) : undefined
      await withStoreLockRetry(layout.lock, async () => {
        let watch = store.loadWatchlist()
        const sub = subscribeAfterResearch({
          file: watch,
          identity: trackWatchIdentity,
          guildId: request.guildId,
          userId: request.userId,
          channelId: request.channelId,
          messageId: request.messageId,
          nowIso,
          baseline: trackWatchBaseline,
          ...(researchBrief ? { researchBrief } : {}),
          securityHardFail: Boolean(result.securityHardFail),
        })
        if (sub.subscribed) {
          await store.saveWatchlist(sub.file)
          const obs = store.loadObservations()
          obs.byToken[tokenKey(trackWatchIdentity.chain, trackWatchIdentity.tokenAddress)] =
            trackWatchBaseline
          await store.saveObservations(obs)
        }
      })
    } catch {
      // silent
    }
  }

  if (
    result.mainTrackEligible
    && result.identity
    && result.runId
    && result.security
    && !result.securityHardFail
  ) {
    try {
      await promoteDiscordTrackToMain({
        discordAgentRoot: layout.agent,
        discordArchiveRoot: layout.archive,
        runId: result.runId,
        identity: result.identity,
        security: result.security,
      })
    } catch {
      // silent
    }
  }
}

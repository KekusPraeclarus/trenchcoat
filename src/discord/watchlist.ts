import { loadConfig } from "../lib/config.js"
import type { CanonicalIdentity } from "../contracts/schemas.js"
import {
  tokenKey,
  type DiscordObservation,
  type DiscordSubscription,
  type DiscordWatchlistFile,
  type DiscordWatchToken,
} from "./schemas.js"

export function activeSubscriptions(
  token: DiscordWatchToken,
  nowIso: string,
): DiscordSubscription[] {
  const now = Date.parse(nowIso)
  return token.subscriptions.filter((s) => Date.parse(s.expiresAt) > now)
}

export function pruneExpiredWatchlist(
  file: DiscordWatchlistFile,
  nowIso: string,
): DiscordWatchlistFile {
  const tokens = file.tokens.flatMap((token) => {
    const subs = activeSubscriptions(token, nowIso)
    if (subs.length === 0) return []
    return [{ ...token, subscriptions: subs }]
  })
  return tokens.length === file.tokens.length ? file : { ...file, tokens }
}

export function findWatchToken(
  file: DiscordWatchlistFile,
  chain: string,
  tokenAddress: string,
): DiscordWatchToken | undefined {
  const key = tokenKey(chain, tokenAddress)
  return file.tokens.find((t) => tokenKey(t.chain, t.tokenAddress) === key)
}

export function countActiveTokens(file: DiscordWatchlistFile, nowIso: string): number {
  return pruneExpiredWatchlist(file, nowIso).tokens.length
}

export function countActiveSubscribers(token: DiscordWatchToken, nowIso: string): number {
  return activeSubscriptions(token, nowIso).length
}

export type WatchSubscribeResult = Readonly<{
  file: DiscordWatchlistFile
  subscribed: boolean
  capacityReason?: "tokens" | "subscribers"
}>

export function subscribeAfterResearch(args: Readonly<{
  file: DiscordWatchlistFile
  identity: CanonicalIdentity
  guildId: string
  userId: string
  channelId: string
  messageId: string
  nowIso: string
  baseline: DiscordObservation
  researchBrief?: string
  securityHardFail?: boolean
}>): WatchSubscribeResult {
  if (args.securityHardFail) {
    return { file: args.file, subscribed: false }
  }

  const config = loadConfig()
  const maxTokens = config.chat.discord.max_watched_tokens
  const maxSubs = config.chat.discord.max_subscribers_per_token
  const watchDays = config.chat.discord.watch_days
  const expiresAt = new Date(Date.parse(args.nowIso) + watchDays * 86_400_000).toISOString()

  let file = pruneExpiredWatchlist(args.file, args.nowIso)
  const existing = findWatchToken(file, args.identity.chain, args.identity.tokenAddress)
  const activeTokenCount = countActiveTokens(file, args.nowIso)

  if (!existing && activeTokenCount >= maxTokens) {
    return { file, subscribed: false, capacityReason: "tokens" }
  }

  const subscription: DiscordSubscription = {
    guildId: args.guildId,
    userId: args.userId,
    channelId: args.channelId,
    messageId: args.messageId,
    startedAt: args.nowIso,
    renewedAt: args.nowIso,
    expiresAt,
  }

  if (existing) {
    const active = activeSubscriptions(existing, args.nowIso)
    const withoutUser = active.filter((s) => s.userId !== args.userId)
    if (withoutUser.length >= maxSubs) {
      return { file, subscribed: false, capacityReason: "subscribers" }
    }
    const updated: DiscordWatchToken = {
      ...existing,
      symbolDisplay: args.identity.symbolDisplay ?? existing.symbolDisplay,
      ...(args.researchBrief ? { researchBrief: args.researchBrief } : {}),
      subscriptions: [...withoutUser, subscription],
    }
    return {
      file: {
        ...file,
        tokens: file.tokens.map((t) => (
          tokenKey(t.chain, t.tokenAddress) === tokenKey(updated.chain, updated.tokenAddress)
            ? updated
            : t
        )),
      },
      subscribed: true,
    }
  }

  if (activeTokenCount >= maxTokens) {
    return { file, subscribed: false, capacityReason: "tokens" }
  }

  const token: DiscordWatchToken = {
    chain: args.identity.chain,
    tokenAddress: args.identity.tokenAddress,
    symbolDisplay: args.identity.symbolDisplay,
    ...(args.researchBrief ? { researchBrief: args.researchBrief } : {}),
    subscriptions: [subscription],
  }
  return { file: { ...file, tokens: [...file.tokens, token] }, subscribed: true }
}

export function renewSubscription(args: Readonly<{
  file: DiscordWatchlistFile
  guildId: string
  userId: string
  anchorMessageId: string
  nowIso: string
}>): { ok: true; file: DiscordWatchlistFile } | { ok: false; reason: "not-found" | "expired" | "unauthorized" } {
  const config = loadConfig()
  const watchDays = config.chat.discord.watch_days
  const graceMs = 7 * 86_400_000
  const expiresAt = new Date(Date.parse(args.nowIso) + watchDays * 86_400_000).toISOString()

  let found = false
  const tokens = args.file.tokens.map((token) => {
    const subs = token.subscriptions.map((sub) => {
      if (
        sub.guildId !== args.guildId
        || sub.userId !== args.userId
        || sub.messageId !== args.anchorMessageId
      ) return sub
      found = true
      const expiredMs = Date.parse(args.nowIso) - Date.parse(sub.expiresAt)
      if (expiredMs > graceMs) return sub
      return { ...sub, renewedAt: args.nowIso, expiresAt }
    })
    return { ...token, subscriptions: subs }
  })

  if (!found) return { ok: false, reason: "not-found" }
  const target = tokens.flatMap((t) => t.subscriptions).find((s) => (
    s.guildId === args.guildId
    && s.userId === args.userId
    && s.messageId === args.anchorMessageId
  ))
  if (!target) return { ok: false, reason: "not-found" }
  if (Date.parse(args.nowIso) - Date.parse(target.expiresAt) > graceMs) {
    return { ok: false, reason: "expired" }
  }
  return { ok: true, file: { ...args.file, tokens } }
}

export function newestAnchorSubscription(
  token: DiscordWatchToken,
  nowIso: string,
): DiscordSubscription | undefined {
  const active = activeSubscriptions(token, nowIso)
  return active.sort((a, b) => Date.parse(b.renewedAt) - Date.parse(a.renewedAt))[0]
}

export function otherSubscriberIds(
  token: DiscordWatchToken,
  anchor: DiscordSubscription,
  nowIso: string,
): string[] {
  return activeSubscriptions(token, nowIso)
    .filter((s) => s.userId !== anchor.userId)
    .map((s) => s.userId)
    .sort()
    .slice(0, 99)
}

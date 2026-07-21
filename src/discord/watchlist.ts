import { loadConfig } from "../lib/config.js"
import type { CanonicalIdentity } from "../contracts/schemas.js"
import {
  tokenKey,
  type DiscordObservation,
  type DiscordSubscription,
  type DiscordWatchlistFile,
  type DiscordWatchToken,
} from "./schemas.js"

/** Host quality gate for Discord watch subscribe (ADR 021) */
export function discordWatchSubscribeEligible(args: Readonly<{
  hasIdentity: boolean
  hasBaseline: boolean
  subscribeAllowed?: boolean | undefined
  mainTrackEligible?: boolean | undefined
  securityHardFail?: boolean | undefined
}>): boolean {
  return Boolean(
    args.hasIdentity
    && args.hasBaseline
    && args.subscribeAllowed
    && args.mainTrackEligible
    && !args.securityHardFail
  )
}

export function watchExpiryReplyWindowMs(config = loadConfig()): number {
  return config.chat.discord.watch_expiry_reply_window_days * 86_400_000
}

/** Active = not yet expired (receives watch updates) */
export function activeSubscriptions(
  token: DiscordWatchToken,
  nowIso: string,
): DiscordSubscription[] {
  const now = Date.parse(nowIso)
  return token.subscriptions.filter((s) => Date.parse(s.expiresAt) > now)
}

/** Awaiting reply: expired, notice sent, still inside reply window */
export function isExpiredAwaitingReply(
  sub: DiscordSubscription,
  nowIso: string,
  replyWindowMs: number,
): boolean {
  const now = Date.parse(nowIso)
  if (Date.parse(sub.expiresAt) > now) return false
  if (!sub.expiryNoticeMessageId || !sub.expiryNoticeAt) return false
  return now < Date.parse(sub.expiryNoticeAt) + replyWindowMs
}

/** Keep if active, awaiting-reply, or expired-without-notice still inside window from expiresAt */
export function retainSubscription(
  sub: DiscordSubscription,
  nowIso: string,
  replyWindowMs: number,
): boolean {
  const now = Date.parse(nowIso)
  if (Date.parse(sub.expiresAt) > now) return true
  if (isExpiredAwaitingReply(sub, nowIso, replyWindowMs)) return true
  if (!sub.expiryNoticeMessageId) {
    return now < Date.parse(sub.expiresAt) + replyWindowMs
  }
  return false
}

export function pruneExpiredWatchlist(
  file: DiscordWatchlistFile,
  nowIso: string,
  replyWindowMs = watchExpiryReplyWindowMs(),
): DiscordWatchlistFile {
  const tokens = file.tokens.flatMap((token) => {
    const subs = token.subscriptions.filter((s) => (
      retainSubscription(s, nowIso, replyWindowMs)
    ))
    if (subs.length === 0) return []
    return [{ ...token, subscriptions: subs }]
  })
  return tokens.length === file.tokens.length
    && tokens.every((t, i) => t.subscriptions.length === file.tokens[i]!.subscriptions.length)
    ? file
    : { ...file, tokens }
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
  return pruneExpiredWatchlist(file, nowIso).tokens.filter((t) => (
    activeSubscriptions(t, nowIso).length > 0
  )).length
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
  const graceMs = watchExpiryReplyWindowMs(config)
  const expiresAt = new Date(Date.parse(args.nowIso) + watchDays * 86_400_000).toISOString()

  let found = false
  let renewed = false
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
      renewed = true
      return {
        ...sub,
        renewedAt: args.nowIso,
        expiresAt,
        expiryNoticeMessageId: undefined,
        expiryNoticeAt: undefined,
      }
    })
    return { ...token, subscriptions: subs }
  })

  if (!found) return { ok: false, reason: "not-found" }
  if (!renewed) return { ok: false, reason: "expired" }
  return { ok: true, file: { ...args.file, tokens } }
}

export type WatchExpiryNoticePlan = Readonly<{
  userId: string
  channelId: string
  guildId: string
  labels: readonly string[]
  /** Keys `${chain}:${tokenAddress}:${userId}` for subscriptions covered */
  subscriptionKeys: readonly string[]
}>

export function planWatchExpiryNotices(args: Readonly<{
  file: DiscordWatchlistFile
  nowIso: string
  replyWindowMs?: number
}>): WatchExpiryNoticePlan[] {
  const now = Date.parse(args.nowIso)
  const windowMs = args.replyWindowMs ?? watchExpiryReplyWindowMs()
  const byUserChannel = new Map<string, {
    userId: string
    channelId: string
    guildId: string
    labels: string[]
    subscriptionKeys: string[]
  }>()

  for (const token of args.file.tokens) {
    const label = token.symbolDisplay
      ?? `${token.chain}:${token.tokenAddress.slice(0, 8)}`
    for (const sub of token.subscriptions) {
      if (Date.parse(sub.expiresAt) > now) continue
      if (sub.expiryNoticeMessageId) continue
      if (now >= Date.parse(sub.expiresAt) + windowMs) continue
      const key = `${sub.userId}:${sub.channelId}`
      const existing = byUserChannel.get(key)
      const subKey = `${token.chain}:${token.tokenAddress}:${sub.userId}`
      if (existing) {
        if (!existing.labels.includes(label)) existing.labels.push(label)
        existing.subscriptionKeys.push(subKey)
      } else {
        byUserChannel.set(key, {
          userId: sub.userId,
          channelId: sub.channelId,
          guildId: sub.guildId,
          labels: [label],
          subscriptionKeys: [subKey],
        })
      }
    }
  }

  return [...byUserChannel.values()].map((v) => ({
    userId: v.userId,
    channelId: v.channelId,
    guildId: v.guildId,
    labels: v.labels,
    subscriptionKeys: v.subscriptionKeys,
  }))
}

export function renderWatchExpiryNotice(args: Readonly<{
  userId: string
  labels: readonly string[]
}>): string {
  const labelText = args.labels.slice(0, 12).join(", ")
  return [
    `<@${args.userId}> your watch on ${labelText} has expired.`,
    "Extend another month? (yes/no)",
  ].join(" ").slice(0, 2_000)
}

export function applyWatchExpiryNoticeSent(args: Readonly<{
  file: DiscordWatchlistFile
  plan: WatchExpiryNoticePlan
  noticeMessageId: string
  nowIso: string
}>): DiscordWatchlistFile {
  const keySet = new Set(args.plan.subscriptionKeys)
  return {
    ...args.file,
    tokens: args.file.tokens.map((token) => ({
      ...token,
      subscriptions: token.subscriptions.map((sub) => {
        const key = `${token.chain}:${token.tokenAddress}:${sub.userId}`
        if (!keySet.has(key)) return sub
        if (sub.userId !== args.plan.userId) return sub
        if (sub.channelId !== args.plan.channelId) return sub
        if (Date.parse(sub.expiresAt) > Date.parse(args.nowIso)) return sub
        if (sub.expiryNoticeMessageId) return sub
        return {
          ...sub,
          expiryNoticeMessageId: args.noticeMessageId,
          expiryNoticeAt: args.nowIso,
        }
      }),
    })),
  }
}

const WATCH_YES_RE = /^(?:yes|yeah|yep|y|renew|keep\s+watching)\b/iu
const WATCH_NO_RE = /^(?:no|nope|nah|n)\b/iu

export function classifyWatchExpiryReply(text: string): "yes" | "no" | "other" {
  const trimmed = text.trim()
  if (WATCH_YES_RE.test(trimmed)) return "yes"
  if (WATCH_NO_RE.test(trimmed)) return "no"
  return "other"
}

export function findSubscriptionsByNotice(args: Readonly<{
  file: DiscordWatchlistFile
  noticeMessageId: string
  userId: string
}>): ReadonlyArray<{ token: DiscordWatchToken; subscription: DiscordSubscription }> {
  const out: { token: DiscordWatchToken; subscription: DiscordSubscription }[] = []
  for (const token of args.file.tokens) {
    for (const sub of token.subscriptions) {
      if (
        sub.expiryNoticeMessageId === args.noticeMessageId
        && sub.userId === args.userId
      ) {
        out.push({ token, subscription: sub })
      }
    }
  }
  return out
}

export function applyWatchExpiryReply(args: Readonly<{
  file: DiscordWatchlistFile
  noticeMessageId: string
  userId: string
  decision: "yes" | "no"
  nowIso: string
}>): { ok: true; file: DiscordWatchlistFile; renewed: number; removed: number }
  | { ok: false; reason: "not-found" } {
  const matches = findSubscriptionsByNotice({
    file: args.file,
    noticeMessageId: args.noticeMessageId,
    userId: args.userId,
  })
  if (matches.length === 0) return { ok: false, reason: "not-found" }

  const config = loadConfig()
  const watchDays = config.chat.discord.watch_days
  const expiresAt = new Date(Date.parse(args.nowIso) + watchDays * 86_400_000).toISOString()
  const matchKeys = new Set(
    matches.map((m) => `${m.token.chain}:${m.token.tokenAddress}:${m.subscription.userId}`),
  )

  let renewed = 0
  let removed = 0
  const tokens = args.file.tokens.flatMap((token) => {
    const subscriptions = token.subscriptions.flatMap((sub) => {
      const key = `${token.chain}:${token.tokenAddress}:${sub.userId}`
      if (!matchKeys.has(key) || sub.expiryNoticeMessageId !== args.noticeMessageId) {
        return [sub]
      }
      if (args.decision === "no") {
        removed += 1
        return []
      }
      renewed += 1
      return [{
        ...sub,
        renewedAt: args.nowIso,
        expiresAt,
        expiryNoticeMessageId: undefined,
        expiryNoticeAt: undefined,
      }]
    })
    if (subscriptions.length === 0) return []
    return [{ ...token, subscriptions }]
  })

  return { ok: true, file: { ...args.file, tokens }, renewed, removed }
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

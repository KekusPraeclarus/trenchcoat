import type { TrenchcoatConfig } from "../lib/config.js"
import type { DiscordRequestRecord, DiscordRequestsFile } from "./schemas.js"
import { rolloverQuotaDay } from "./store.js"

export const DISCORD_ERRORS = {
  ACTIVE: "You already have too many research requests queued.",
  USER_CAP: "Daily research limit reached. Try again after 00:00 UTC.",
  SERVER_CAP: "Daily research limit reached. Try again after 00:00 UTC.",
  MULTI_NETWORK: "Multiple networks found. Resend as chain:address.",
  NO_MARKET: "No supported market found for that contract.",
  FAILED: "Research failed. Please try again later.",
  BUSY: "Bot is busy. Try again in a moment.",
  WATCH_CAPACITY: "Watchlist capacity reached; this token was not added.",
} as const

/** Terminal failures do not consume daily quota */
export function chargesDailyQuota(status: DiscordRequestRecord["status"]): boolean {
  return status === "queued" || status === "running" || status === "completed"
}

/** Recompute UTC-day counters from non-failed requests (source of truth) */
export function recountDailyQuota(
  file: DiscordRequestsFile,
  nowIso: string,
): DiscordRequestsFile {
  const next = rolloverQuotaDay(file, nowIso)
  const dailyByUser: Record<string, number> = {}
  let dailyServer = 0
  for (const r of next.requests) {
    if (r.quotaDay !== next.quotaDay) continue
    if (!chargesDailyQuota(r.status)) continue
    dailyByUser[r.userId] = (dailyByUser[r.userId] ?? 0) + 1
    dailyServer += 1
  }
  return { ...next, dailyByUser, dailyServer }
}

export function activeRequestForUser(
  file: DiscordRequestsFile,
  userId: string,
): DiscordRequestsFile["requests"][number] | undefined {
  return file.requests.find((r) => (
    r.userId === userId && (r.status === "queued" || r.status === "running")
  ))
}

/** queued + running count for per-user queue depth */
export function countActiveForUser(
  file: DiscordRequestsFile,
  userId: string,
): number {
  return file.requests.filter((r) => (
    r.userId === userId && (r.status === "queued" || r.status === "running")
  )).length
}

export function quotaAllows(
  file: DiscordRequestsFile,
  userId: string,
  config: TrenchcoatConfig,
  nowIso: string,
): { ok: true; file: DiscordRequestsFile } | { ok: false; file: DiscordRequestsFile; reason: "user" | "server" } {
  const next = recountDailyQuota(file, nowIso)
  const userCount = next.dailyByUser[userId] ?? 0
  if (userCount >= config.chat.discord.per_user_daily_cap) {
    return { ok: false, file: next, reason: "user" }
  }
  if (next.dailyServer >= config.chat.discord.server_daily_cap) {
    return { ok: false, file: next, reason: "server" }
  }
  return { ok: true, file: next }
}

/** @deprecated Prefer recountDailyQuota after mutating requests; kept for tests */
export function consumeQuota(
  file: DiscordRequestsFile,
  userId: string,
  nowIso: string,
): DiscordRequestsFile {
  const next = rolloverQuotaDay(file, nowIso)
  const userCount = next.dailyByUser[userId] ?? 0
  return {
    ...next,
    dailyByUser: { ...next.dailyByUser, [userId]: userCount + 1 },
    dailyServer: next.dailyServer + 1,
  }
}

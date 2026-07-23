import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { SnapshotWriter } from "../lib/snapshot.js"
import { loadConfig, type TrenchcoatConfig } from "../lib/config.js"
import { StateStore } from "../lib/state.js"
import { enqueueResearch } from "../lib/research-queue.js"
import type { ResearchQueueEntry } from "../contracts/schemas.js"
import {
  createDiscordRestClient,
  type DiscordHistoryMessage,
  type DiscordRestClient,
} from "../discord/bot-client.js"
import { fetchChannelWindow } from "../discord/history.js"
import { discordLayout } from "../discord/paths.js"
import { parseDiscordWalletMessage } from "../collectors/discord-wallet/parse.js"
import { deriveDiscordWalletSignals } from "../collectors/discord-wallet/derive.js"
import {
  emptyObservationCache,
  loadObservationCache,
  mergeObservations,
  saveObservationCache,
} from "../collectors/discord-wallet/observations.js"
import type { TxEvent } from "../collectors/discord-wallet/types.js"
import { resolveResearchSubject } from "./research-collect.js"
import type { CollectionSummary } from "./collect.js"
import type { FetchLike } from "../collectors/market/geckoterminal.js"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { isNativeOrWrapMint } from "../lib/native-mints.js"

function expiryIso(nowIso: string, days: number): string {
  return new Date(Date.parse(nowIso) + days * 86_400_000).toISOString()
}

function eventHash(parts: Readonly<Record<string, string | number | undefined>>): string {
  const stable = Object.keys(parts).sort().map((key) => `${key}=${parts[key] ?? ""}`).join("|")
  return createHash("sha256").update(stable).digest("hex").slice(0, 24)
}

type CursorFile = Readonly<{
  schema: 1
  channels: Readonly<Record<string, Readonly<{ lastMessageId: string, updatedAt: string }>>>
}>

function loadCursors(path: string): CursorFile {
  if (!existsSync(path)) return { schema: 1, channels: {} }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as CursorFile
    if (raw.schema !== 1 || typeof raw.channels !== "object" || !raw.channels) {
      return { schema: 1, channels: {} }
    }
    return raw
  } catch {
    return { schema: 1, channels: {} }
  }
}

async function saveCursors(path: string, file: CursorFile): Promise<void> {
  mkdirSync(join(path, ".."), { recursive: true })
  await writeAtomicFile(path, `${JSON.stringify(file, null, 2)}\n`)
}

function activityCursorPath(archiveRoot: string): string {
  return join(archiveRoot, "provider-cursors", "discord-wallet", "activity.json")
}

function enqueueReceiptPath(archiveRoot: string, day: string): string {
  return join(archiveRoot, "provider-usage", "discord-wallet", `enqueues-${day}.json`)
}

async function saveActivityCursor(archiveRoot: string, since: string): Promise<void> {
  const path = activityCursorPath(archiveRoot)
  mkdirSync(join(path, ".."), { recursive: true })
  await writeAtomicFile(path, `${JSON.stringify({ schema: 1, since }, null, 2)}\n`)
}

async function loadEnqueueCount(archiveRoot: string, day: string): Promise<number> {
  const path = enqueueReceiptPath(archiveRoot, day)
  if (!existsSync(path)) return 0
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { count?: number }
    return Number(raw.count ?? 0)
  } catch {
    return 0
  }
}

async function saveEnqueueCount(archiveRoot: string, day: string, count: number): Promise<void> {
  const path = enqueueReceiptPath(archiveRoot, day)
  mkdirSync(join(path, ".."), { recursive: true })
  await writeAtomicFile(path, `${JSON.stringify({ schema: 1, day, count }, null, 2)}\n`)
}

function skipSummary(names: string[], status: string): CollectionSummary {
  return {
    snapshotNames: names,
    fypAuthors: [],
    discoverySightings: [],
    fcDiscoverySightings: [],
    fypPosts: [],
    fypCasts: [],
    postCount: 0,
    skipAgent: true,
    collectionKind: "host-only",
    collectionStatus: status,
  }
}

async function writeSkip(
  args: Readonly<{ runId: string, writer: SnapshotWriter, fetchedAt: string }>,
  reason: string,
): Promise<string[]> {
  await args.writer.writeInbox(args.runId, "collection-status", {
    source: "host.discord-wallet-signals",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: [{
      provenance: `${args.runId}:discord-wallet:${reason}`,
      text: `kind=skip reason=${reason}`,
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live",
    }],
  })
  return ["collection-status"]
}

function messageBodyEmpty(message: DiscordHistoryMessage): boolean {
  const embedText = message.embeds?.[0]?.description?.trim() ?? ""
  return message.content.trim().length === 0 && embedText.length === 0
}

function withinAge(message: DiscordHistoryMessage, nowIso: string, maxAgeHours: number): boolean {
  const ts = Date.parse(message.timestamp)
  const now = Date.parse(nowIso)
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return false
  return now - ts <= maxAgeHours * 3_600_000
}

export async function collectDiscordWalletSignalScan(args: Readonly<{
  runId: string
  writer: SnapshotWriter
  fetchedAt: string
  agentRoot: string
  archiveRoot: string
  fetcher?: FetchLike
  client?: DiscordRestClient
  botUserId?: string
  config?: TrenchcoatConfig
  cursorPath?: string
}>): Promise<CollectionSummary> {
  const config = args.config ?? loadConfig()
  const walletSignals = config.chat.discord.wallet_signals
  if (!walletSignals.enabled) {
    return skipSummary(await writeSkip(args, "wallet-signals-disabled"), "wallet-signals-disabled")
  }
  if (!config.chat.discord.enabled || !config.chat.discord.guild_id) {
    return skipSummary(
      await writeSkip(args, "wallet-signals-misconfigured"),
      "wallet-signals-misconfigured",
    )
  }
  if (walletSignals.channel_ids.length < 1) {
    return skipSummary(
      await writeSkip(args, "wallet-signals-misconfigured"),
      "wallet-signals-misconfigured",
    )
  }
  const token = process.env["DISCORD_RESEARCH_BOT_TOKEN"]?.trim()
  if (!args.client && !token) {
    return skipSummary(await writeSkip(args, "discord-token-missing"), "discord-token-missing")
  }

  const client = args.client ?? createDiscordRestClient(token!)
  const botUserId = args.botUserId
    ?? (await client.getBotUserId?.().catch(() => undefined))
  const layout = discordLayout()
  const cursorPath = args.cursorPath ?? layout.walletSignalCursors
  const cursors = loadCursors(cursorPath)
  const nextChannels: Record<string, { lastMessageId: string, updatedAt: string }> = {
    ...cursors.channels,
  }

  const parsedEvents: TxEvent[] = []
  for (const channelId of walletSignals.channel_ids) {
    const after = cursors.channels[channelId]?.lastMessageId
    const maxPages = after ? Number.POSITIVE_INFINITY : 5
    const messages = await fetchChannelWindow({
      client,
      channelId,
      ...(after ? { after } : {}),
      maxPages,
    })
    let newestId = after
    for (const message of messages) {
      if (newestId === undefined || message.id > newestId) newestId = message.id
      if (botUserId && message.authorId === botUserId) continue
      if (messageBodyEmpty(message)) continue
      if (!withinAge(message, args.fetchedAt, walletSignals.max_message_age_hours)) continue
      const event = parseDiscordWalletMessage(message)
      if (event) parsedEvents.push(event)
    }
    if (newestId) {
      nextChannels[channelId] = { lastMessageId: newestId, updatedAt: args.fetchedAt }
    }
  }

  await saveCursors(cursorPath, { schema: 1, channels: nextChannels })
  await saveActivityCursor(args.archiveRoot, args.fetchedAt)

  const cache = loadObservationCache(args.archiveRoot) ?? emptyObservationCache(args.fetchedAt)
  const merged = mergeObservations(cache, parsedEvents, args.fetchedAt)
  await saveObservationCache(args.archiveRoot, merged)

  const signals = deriveDiscordWalletSignals({
    events: merged.events,
    observedAt: args.fetchedAt,
    actorDedupeTtlMinutes: walletSignals.actor_dedupe_ttl_minutes,
    convergence: {
      enabled: walletSignals.convergence.enabled,
      windowMinutes: walletSignals.convergence.window_minutes,
      minActors: walletSignals.convergence.min_actors,
    },
    sellPressure: {
      enabled: walletSignals.sell_pressure.enabled,
      windowMinutes: walletSignals.sell_pressure.window_minutes,
      minActors: walletSignals.sell_pressure.min_actors,
    },
  })

  const signalLines = signals.length === 0
    ? ["kind=status status=no-signals"]
    : signals.map((signal) => (
      `kind=${signal.kind} polarity=${signal.polarity}`
        + (signal.chain ? ` chain=${signal.chain}` : "")
        + ` token=${signal.tokenContract}`
        + ` actors=${signal.actors.join(",")}`
        + ` actorCount=${signal.actors.length}`
        + ` windowMinutes=${signal.kind === "convergence"
          ? walletSignals.convergence.window_minutes
          : walletSignals.sell_pressure.window_minutes}`
        + ` observedAt=${signal.observedAt}`
    ))

  await args.writer.writeInbox(args.runId, "discord-wallet-signals", {
    source: "host.discord-wallet-signals",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: signalLines.map((text, index) => ({
      provenance: `${args.runId}:discord-wallet:signal:${index}`,
      text: text.slice(0, 20_000),
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live" as const,
    })),
  })

  let enqueued = 0
  if (!walletSignals.shadow_mode) {
    const day = args.fetchedAt.slice(0, 10)
    let used = await loadEnqueueCount(args.archiveRoot, day)
    const state = new StateStore(join(args.agentRoot, "state"))
    let queue = state.loadResearchQueue()
    const watchlist = state.loadWatchlist()
    const watchlistKeys = new Set(
      watchlist.entries.map((entry) => `${entry.identity.chain}:${entry.identity.tokenAddress}`),
    )
    const recentKeys = new Set(
      queue.entries
        .filter((entry) => Date.parse(args.fetchedAt) - Date.parse(entry.firstSeen) <= 7 * 86_400_000)
        .map((entry) => `${entry.chain}:${entry.tokenAddress}`),
    )

    for (const signal of signals) {
      if (signal.kind !== "convergence" || signal.polarity !== "bullish") continue
      if (used >= walletSignals.max_enqueues_per_day) break
      if (isNativeOrWrapMint(signal.tokenContract)) continue
      const chain = signal.chain ?? "solana"
      const key = `${chain}:${signal.tokenContract}`
      if (watchlistKeys.has(key) || recentKeys.has(key)) continue
      const resolved = await resolveResearchSubject(
        { subject: signal.tokenContract, chainHint: chain as never },
        args.fetcher ?? globalThis.fetch,
      )
      if (resolved.status !== "resolved") continue
      if (isNativeOrWrapMint(resolved.identity.tokenAddress)) continue
      const hash = eventHash({
        kind: signal.kind,
        chain: resolved.identity.chain,
        token: resolved.identity.tokenAddress,
        at: signal.observedAt,
      })
      const entry: ResearchQueueEntry = {
        schema: 1,
        queueId: `rq-discord-wallet-convergence-${hash}`,
        subject: `${resolved.identity.chain}:${resolved.identity.tokenAddress}`,
        chain: resolved.identity.chain,
        tokenAddress: resolved.identity.tokenAddress,
        ...(resolved.identity.pairAddress ? { pairAddress: resolved.identity.pairAddress } : {}),
        ...(resolved.identity.symbolDisplay
          ? { symbolDisplay: resolved.identity.symbolDisplay.slice(0, 32) }
          : {}),
        resolution: "resolved",
        priority: 50,
        firstSeen: args.fetchedAt,
        enqueuedAt: args.fetchedAt,
        enqueuedBy: "discord-wallet:convergence",
        trigger: "social",
        expiresAt: expiryIso(args.fetchedAt, config.research.queue_expiry_days),
        provenance: [
          `discord-wallet:convergence:${resolved.identity.chain}:${resolved.identity.tokenAddress}:${hash}`,
        ],
        clusterCount: signal.actors.length,
        security: { status: "pending", flags: [] },
        status: "pending",
        reason: "discord wallet buy confluence".slice(0, 280),
      }
      queue = enqueueResearch(queue, entry, config.research.daily_cap)
      enqueued += 1
      used += 1
      recentKeys.add(`${resolved.identity.chain}:${resolved.identity.tokenAddress}`)
    }
    await state.saveResearchQueue(queue)
    await saveEnqueueCount(args.archiveRoot, day, used)
  }

  return {
    snapshotNames: ["discord-wallet-signals"],
    fypAuthors: [],
    discoverySightings: [],
    fcDiscoverySightings: [],
    fypPosts: [],
    fypCasts: [],
    postCount: signals.length,
    skipAgent: true,
    collectionKind: "host-only",
    collectionStatus: walletSignals.shadow_mode
      ? `discord-wallet-shadow signals=${signals.length} events=${parsedEvents.length}`
      : `discord-wallet-enqueued=${enqueued} signals=${signals.length}`,
  }
}

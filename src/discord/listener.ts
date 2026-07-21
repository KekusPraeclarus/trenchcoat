import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js"
import { join } from "node:path"
import { systemClock } from "../lib/clock.js"
import { loadConfig } from "../lib/config.js"
import { log } from "../lib/log.js"
import { WorkspaceLock } from "../lib/lock.js"
import { discordLayout } from "./paths.js"
import { createDiscordStore } from "./store.js"
import { extractDiscordResearchIntent, isRenewText } from "./intent.js"
import {
  acceptDiscordRequest,
  processNextDiscordRequest,
  reclaimOrphanedDiscordRequests,
} from "./pump.js"
import { createDiscordRestClient } from "./bot-client.js"
import { deliverRenewalAck } from "./delivery.js"
import { renewSubscription } from "./watchlist.js"
import {
  applyWatchExpiryReply,
  classifyWatchExpiryReply,
  findSubscriptionsByNotice,
} from "./watchlist.js"
import { acceptChainIntegration } from "../chain-integration/intake.js"
import { kickChainIntegrationWorker } from "../chain-integration/kick.js"
import { reactAcceptedSources } from "../chain-integration/continue.js"
import { handleTrackingMessage } from "./tracking-intent.js"
import { DISCORD_TRACKING_ACK_EMOJI } from "./tracking-intent.js"
import { kickTrackingWorker } from "./tracking-worker.js"
import {
  createChannelContextBuffer,
  evaluateConversationAddressed,
  type ChannelContextBuffer,
} from "./conversation-intent.js"
import {
  handleConversationTurn,
  reclaimConversationState,
} from "./conversation.js"

export type DiscordListenerOpts = Readonly<{
  token: string
  repoRoot: string
  onFatal?: (error: unknown) => void
}>

function isAllowedMessage(
  message: Message,
  guildId: string,
  channelIds: readonly string[],
): boolean {
  if (message.author.bot) return false
  if (message.webhookId) return false
  if (!message.guildId || message.guildId !== guildId) return false
  if (!channelIds.includes(message.channelId)) return false
  if (message.partial) return false
  return true
}

async function handleRenewal(message: Message, token: string): Promise<void> {
  if (!isRenewText(message.content)) return
  const config = loadConfig()
  if (!config.chat.discord.enabled) return
  const layout = discordLayout()
  const store = createDiscordStore(layout)
  const lock = new WorkspaceLock(layout.lock)
  if (!lock.tryAcquire()) return

  try {
    const referenced = message.reference?.messageId
    if (!referenced) return
    const renewed = renewSubscription({
      file: store.loadWatchlist(),
      guildId: message.guildId!,
      userId: message.author.id,
      anchorMessageId: referenced,
      nowIso: systemClock.nowIso(),
    })
    if (!renewed.ok) return
    await store.saveWatchlist(renewed.file)
    const client = createDiscordRestClient(token)
    await deliverRenewalAck({
      client,
      channelId: message.channelId,
      messageId: message.id,
    })
  } finally {
    lock.release()
  }
}

async function handleWatchExpiryReply(
  message: Message,
  token: string,
): Promise<"handled" | "other" | "ignored"> {
  const referenced = message.reference?.messageId
  if (!referenced) return "ignored"
  const config = loadConfig()
  if (!config.chat.discord.enabled) return "ignored"
  const layout = discordLayout()
  const store = createDiscordStore(layout)
  const lock = new WorkspaceLock(layout.lock)
  if (!lock.tryAcquire()) return "ignored"

  try {
    const file = store.loadWatchlist()
    const matches = findSubscriptionsByNotice({
      file,
      noticeMessageId: referenced,
      userId: message.author.id,
    })
    if (matches.length === 0) return "ignored"
    const decision = classifyWatchExpiryReply(message.content)
    if (decision === "other") return "other"
    const applied = applyWatchExpiryReply({
      file,
      noticeMessageId: referenced,
      userId: message.author.id,
      decision,
      nowIso: systemClock.nowIso(),
    })
    if (!applied.ok) return "ignored"
    await store.saveWatchlist(applied.file)
    const client = createDiscordRestClient(token)
    try {
      await client.addReaction({
        channelId: message.channelId,
        messageId: message.id,
        emoji: DISCORD_TRACKING_ACK_EMOJI,
      })
    } catch {
      // best effort
    }
    return "handled"
  } finally {
    lock.release()
  }
}

async function handleResearchMessage(
  message: Message,
  repoRoot: string,
  token: string,
  botUserId: string | undefined,
  context: ChannelContextBuffer,
): Promise<void> {
  const config = loadConfig()
  const contextMax = config.chat.discord.conversation.context_messages
  context.push(message.channelId, {
    authorId: message.author.id,
    authorIsBot: false,
    content: message.content,
    ts: systemClock.nowIso(),
  }, contextMax)

  const watchReply = await handleWatchExpiryReply(message, token)
  if (watchReply === "handled") return

  const intent = extractDiscordResearchIntent(message.content)
  if (intent.kind === "chain-integration") {
    const accepted = await acceptChainIntegration({
      guildId: message.guildId!,
      channelId: message.channelId,
      messageId: message.id,
      userId: message.author.id,
      slug: intent.slug,
      tokenAddress: intent.tokenAddress,
      subject: intent.subject,
    })
    if (!accepted.accepted) {
      const client = createDiscordRestClient(token)
      await client.sendReply({
        channelId: message.channelId,
        content: accepted.terminal.slice(0, 280),
        replyToMessageId: message.id,
      })
      return
    }
    await reactAcceptedSources(accepted.integration, token)
    kickChainIntegrationWorker()
    return
  }
  if (intent.kind === "research") {
    const accepted = await acceptDiscordRequest({
      guildId: message.guildId!,
      channelId: message.channelId,
      messageId: message.id,
      userId: message.author.id,
      subject: intent.subject,
      ...(intent.chainHint ? { chainHint: intent.chainHint } : {}),
      ...(intent.tokenHint ? { tokenHint: intent.tokenHint } : {}),
    })

    if ("duplicate" in accepted) return

    if ("accepted" in accepted && !accepted.accepted) {
      const client = createDiscordRestClient(token)
      await client.sendReply({
        channelId: message.channelId,
        content: accepted.terminal.slice(0, 280),
        replyToMessageId: message.id,
      })
      return
    }

    void pumpLoop(repoRoot, token)
    return
  }

  const mentionsBot = Boolean(
    botUserId && message.mentions.users.has(botUserId),
  )
  let replyToBot = false
  let replyToOtherMember = false
  if (message.reference?.messageId && botUserId) {
    try {
      const ref = await message.fetchReference()
      replyToBot = ref.author.id === botUserId
      replyToOtherMember = !replyToBot && !ref.author.bot
    } catch {
      replyToBot = false
      replyToOtherMember = false
    }
  }

  if (mentionsBot || replyToBot) {
    const tracking = await handleTrackingMessage({
      repoRoot,
      token,
      guildId: message.guildId!,
      channelId: message.channelId,
      messageId: message.id,
      userId: message.author.id,
      content: message.content,
      mentionsBot,
      replyToBot,
      ...(message.reference?.messageId
        ? { referencedMessageId: message.reference.messageId }
        : {}),
    })
    if (tracking === "processed" || tracking === "failed") return
    // tracking none → fall through to conversation
  }

  if (!config.chat.discord.conversation.enabled) return

  const addressed = await evaluateConversationAddressed({
    repoRoot,
    channelId: message.channelId,
    messageId: message.id,
    userId: message.author.id,
    content: message.content,
    mentionsBot,
    replyToBot,
    replyToOtherMember,
    context: context.recent(message.channelId, contextMax),
  })
  if (!addressed) return

  await handleConversationTurn({
    repoRoot,
    token,
    guildId: message.guildId!,
    channelId: message.channelId,
    messageId: message.id,
    userId: message.author.id,
    content: message.content,
  })
}

async function pumpLoop(repoRoot: string, token: string): Promise<void> {
  for (;;) {
    const result = await processNextDiscordRequest({ repoRoot, token })
    if (result === "idle" || result === "busy") break
  }
}

export async function runDiscordListener(opts: DiscordListenerOpts): Promise<void> {
  const config = loadConfig()
  if (!config.chat.discord.enabled) {
    throw new Error("chat.discord.enabled is false")
  }
  const guildId = config.chat.discord.guild_id
  const channelIds = config.chat.discord.channel_ids
  if (!guildId || channelIds.length === 0) {
    throw new Error("chat.discord guild_id and channel_ids required")
  }

  const layout = discordLayout()
  const store = createDiscordStore(layout)
  const context = createChannelContextBuffer()

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  })

  const writeBeat = async (lastError?: string) => {
    await store.writeHeartbeat("listener", {
      schema: 1,
      pid: process.pid,
      updatedAt: systemClock.nowIso(),
      ...(lastError ? { lastError: lastError.slice(0, 500) } : {}),
    })
  }

  client.once("clientReady", () => {
    log.info("discord listener ready")
    void writeBeat()
    if (config.chat.discord.tracking.enabled) {
      kickTrackingWorker(opts.repoRoot)
    }
  })

  client.on("messageCreate", (message) => {
    if (!isAllowedMessage(message, guildId, channelIds)) return
    if (isRenewText(message.content)) {
      void handleRenewal(message, opts.token).catch((error) => {
        log.warn(`discord renewal error: ${error instanceof Error ? error.message : "unknown"}`)
      })
      return
    }
    void handleResearchMessage(
      message,
      opts.repoRoot,
      opts.token,
      client.user?.id,
      context,
    ).catch(async (error) => {
      const msg = error instanceof Error ? error.message : "unknown"
      log.warn(`discord intake error: ${msg}`)
      await writeBeat(msg)
    })
  })

  client.on("error", (error) => {
    log.warn(`discord gateway error: ${error.message}`)
    void writeBeat(error.message)
  })

  const shutdown = async () => {
    client.destroy()
    process.exit(0)
  }
  process.on("SIGINT", () => { void shutdown() })
  process.on("SIGTERM", () => { void shutdown() })

  setInterval(() => { void writeBeat() }, 60_000)

  await client.login(opts.token)
  const reclaimed = await reclaimOrphanedDiscordRequests()
  if (reclaimed > 0) {
    log.info("discord reclaimed orphaned requests", { count: reclaimed })
  }
  const convReclaimed = await reclaimConversationState()
  if (convReclaimed > 0) {
    log.info("discord reclaimed conversation claims", { count: convReclaimed })
  }
  void pumpLoop(opts.repoRoot, opts.token)
}

export function resolveDiscordRepoRoot(): string {
  return join(process.cwd())
}

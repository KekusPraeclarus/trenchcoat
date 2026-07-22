import { createHash } from "node:crypto"

export type DiscordSendPart = Readonly<{
  content: string
  partIndex: number
  partTotal: number
}>

export type DiscordSendResult = Readonly<{
  messageId: string
}>

/** Unicode white_check_mark — research-start ack (not a text reply) */
export const DISCORD_RESEARCH_STARTED_EMOJI = "✅"

export type DiscordRestClient = Readonly<{
  sendReply(args: Readonly<{
    channelId: string
    content: string
    replyToMessageId: string
    mentionUserIds?: readonly string[]
  }>): Promise<DiscordSendResult>
  sendChannelMessage(args: Readonly<{
    channelId: string
    content: string
    mentionUserIds?: readonly string[]
  }>): Promise<DiscordSendResult>
  addReaction(args: Readonly<{
    channelId: string
    messageId: string
    emoji: string
  }>): Promise<void>
  triggerTyping?(args: Readonly<{ channelId: string }>): Promise<void>
  /** Paginated history newest-first; pass after snowflake for forward scan */
  listChannelMessages?(args: Readonly<{
    channelId: string
    after?: string
    limit?: number
  }>): Promise<readonly DiscordHistoryMessage[]>
  getMessage?(args: Readonly<{
    channelId: string
    messageId: string
  }>): Promise<DiscordHistoryMessage | undefined>
}>

const MAX_ATTEMPTS = 8

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function backoffMs(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec !== undefined && Number.isFinite(retryAfterSec)) {
    return Math.min(60_000, Math.max(0, retryAfterSec * 1_000))
  }
  return Math.min(30_000, 500 * 2 ** attempt)
}

async function discordFetch(
  token: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: Record<string, unknown>,
  attempt = 0,
): Promise<Response> {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (
    attempt + 1 < MAX_ATTEMPTS
    && (response.status === 429 || response.status >= 500)
  ) {
    let retryAfter: number | undefined
    try {
      const payload = await response.clone().json() as { retry_after?: number }
      retryAfter = payload.retry_after
    } catch {
      // ignore
    }
    await sleep(backoffMs(attempt, retryAfter))
    return discordFetch(token, method, path, body, attempt + 1)
  }
  return response
}

export type DiscordHistoryMessage = Readonly<{
  id: string
  channelId: string
  authorId: string
  authorIsBot: boolean
  authorIsWebhook: boolean
  content: string
  timestamp: string
  referencedMessageId?: string
}>

const SNOWFLAKE_RE = /^\d{17,20}$/u

function parseHistoryMessage(
  channelId: string,
  raw: Record<string, unknown>,
): DiscordHistoryMessage | undefined {
  const id = typeof raw["id"] === "string" ? raw["id"] : ""
  if (!SNOWFLAKE_RE.test(id)) return undefined
  const author = (raw["author"] ?? {}) as Record<string, unknown>
  const authorId = typeof author["id"] === "string" ? author["id"] : ""
  if (!SNOWFLAKE_RE.test(authorId)) return undefined
  const content = typeof raw["content"] === "string" ? raw["content"] : ""
  const timestamp = typeof raw["timestamp"] === "string" ? raw["timestamp"] : ""
  if (!timestamp) return undefined
  const reference = (raw["message_reference"] ?? {}) as Record<string, unknown>
  const referencedMessageId = typeof reference["message_id"] === "string"
    && SNOWFLAKE_RE.test(reference["message_id"])
    ? reference["message_id"]
    : undefined
  return {
    id,
    channelId,
    authorId,
    authorIsBot: author["bot"] === true,
    authorIsWebhook: typeof raw["webhook_id"] === "string" && raw["webhook_id"].length > 0,
    content,
    timestamp,
    ...(referencedMessageId ? { referencedMessageId } : {}),
  }
}

export function createDiscordRestClient(token: string): DiscordRestClient {
  return {
    async sendReply(args) {
      const allowedMentions = args.mentionUserIds?.length
        ? { parse: [] as string[], users: [...args.mentionUserIds].slice(0, 99) }
        : { parse: [] as string[] }
      const response = await discordFetch(token, "POST", `/channels/${args.channelId}/messages`, {
        content: args.content.slice(0, 2_000),
        message_reference: { message_id: args.replyToMessageId, fail_if_not_exists: false },
        allowed_mentions: allowedMentions,
      })
      if (!response.ok) {
        const detail = await response.text()
        const err = new Error(`discord send failed: ${response.status}`) as Error & {
          status?: number
          unknownMessage?: boolean
        }
        err.status = response.status
        if (response.status === 404 || detail.includes("Unknown Message")) {
          err.unknownMessage = true
        }
        throw err
      }
      const payload = await response.json() as { id: string }
      return { messageId: payload.id }
    },
    async sendChannelMessage(args) {
      const allowedMentions = args.mentionUserIds?.length
        ? { parse: [] as string[], users: [...args.mentionUserIds].slice(0, 99) }
        : { parse: [] as string[] }
      const response = await discordFetch(token, "POST", `/channels/${args.channelId}/messages`, {
        content: args.content.slice(0, 2_000),
        allowed_mentions: allowedMentions,
      })
      if (!response.ok) {
        throw new Error(`discord channel send failed: ${response.status}`)
      }
      const payload = await response.json() as { id: string }
      return { messageId: payload.id }
    },
    async addReaction(args) {
      const emoji = encodeURIComponent(args.emoji)
      const response = await discordFetch(
        token,
        "PUT",
        `/channels/${args.channelId}/messages/${args.messageId}/reactions/${emoji}/@me`,
      )
      if (!response.ok && response.status !== 204) {
        throw new Error(`discord reaction failed: ${response.status}`)
      }
    },
    async triggerTyping(args) {
      const response = await discordFetch(
        token,
        "POST",
        `/channels/${args.channelId}/typing`,
      )
      if (!response.ok && response.status !== 204) {
        // typing is best-effort
      }
    },
    async listChannelMessages(args) {
      if (!SNOWFLAKE_RE.test(args.channelId)) {
        throw new Error("invalid channel id")
      }
      if (args.after !== undefined && !SNOWFLAKE_RE.test(args.after)) {
        throw new Error("invalid after cursor")
      }
      const limit = Math.min(100, Math.max(1, args.limit ?? 100))
      const params = new URLSearchParams({ limit: String(limit) })
      if (args.after) params.set("after", args.after)
      const response = await discordFetch(
        token,
        "GET",
        `/channels/${args.channelId}/messages?${params.toString()}`,
      )
      if (!response.ok) {
        throw new Error(`discord list messages failed: ${response.status}`)
      }
      const payload = await response.json() as unknown
      if (!Array.isArray(payload)) return []
      const messages: DiscordHistoryMessage[] = []
      for (const item of payload) {
        if (!item || typeof item !== "object") continue
        const parsed = parseHistoryMessage(
          args.channelId,
          item as Record<string, unknown>,
        )
        if (parsed) messages.push(parsed)
      }
      return messages
    },
    async getMessage(args) {
      if (!SNOWFLAKE_RE.test(args.channelId) || !SNOWFLAKE_RE.test(args.messageId)) {
        return undefined
      }
      const response = await discordFetch(
        token,
        "GET",
        `/channels/${args.channelId}/messages/${args.messageId}`,
      )
      if (response.status === 404) return undefined
      if (!response.ok) {
        throw new Error(`discord get message failed: ${response.status}`)
      }
      const payload = await response.json() as Record<string, unknown>
      return parseHistoryMessage(args.channelId, payload)
    },
  }
}

export function deliveryContentHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 24)
}

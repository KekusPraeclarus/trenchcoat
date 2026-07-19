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
  method: "POST" | "PUT",
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
  }
}

export function deliveryContentHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 24)
}

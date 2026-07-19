import { createHash } from "node:crypto"
import { splitDiscordText, DISCORD_SAFE_CHUNK } from "../router/deliver.js"
import { stripLocalWorkspaceRefs } from "../lib/telegram-format.js"
import { sanitizeResearchChatBody } from "../orchestrator/chat-report.js"

export function escapeDiscordMarkdown(text: string): string {
  return text
    .replace(/@everyone/giu, "@\u200beveryone")
    .replace(/@here/giu, "@\u200bhere")
    .replace(/<@&\d+>/gu, "")
    .replace(/<@!?\d+>/gu, (m) => m)
}

export function neutralizeRoleMentions(text: string): string {
  return text.replace(/@&\d+/gu, "")
}

export function formatDiscordResearchText(text: string): string {
  const cleaned = sanitizeResearchChatBody(stripLocalWorkspaceRefs(text))
  const lines = cleaned.split("\n").map((line) => {
    const header = /^(#{1,3})\s+(.+)$/u.exec(line)
    if (header?.[2]) return `**${header[2].trim()}**`
    return line
  })
  return escapeDiscordMarkdown(lines.join("\n").trim())
}

export function chunkDiscordReply(text: string, limit = DISCORD_SAFE_CHUNK): string[] {
  return splitDiscordText(formatDiscordResearchText(text), limit)
}

export function partDeliveryKey(
  messageId: string,
  partIndex: number,
  content: string,
): string {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16)
  return `${messageId}:${partIndex}:${hash}`
}

/** Multipart replies are sent bare — no 1/n page labels */
export function labelDiscordParts(parts: readonly string[]): string[] {
  return [...parts]
}

export function sanitizeTerminalError(error: string): string {
  const cleaned = stripLocalWorkspaceRefs(error)
    .replace(/[\u0000-\u001f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
  if (!cleaned) return "Research failed. Please try again later."
  return cleaned.slice(0, 280)
}

/**
 * One-shot: accept + pump a Discord message by id (missed during listener downtime).
 * Usage: pnpm exec tsx scripts/discord-replay-message.ts <channelId> <messageId>
 */
import { acceptDiscordRequest, processNextDiscordRequest } from "../src/discord/pump.js"
import { extractDiscordResearchIntent } from "../src/discord/intent.js"

async function main(): Promise<void> {
  const channelId = process.argv[2]
  const messageId = process.argv[3]
  const token = process.env["DISCORD_RESEARCH_BOT_TOKEN"]
  if (!channelId || !messageId) {
    throw new Error("usage: discord-replay-message.ts <channelId> <messageId>")
  }
  if (!token) throw new Error("missing DISCORD_RESEARCH_BOT_TOKEN")

  const msgRes = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
    { headers: { Authorization: `Bot ${token}` } },
  )
  if (!msgRes.ok) throw new Error(`fetch message failed: ${msgRes.status}`)
  const msg = await msgRes.json() as {
    id: string
    content: string
    author: { id: string }
  }

  const chRes = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
    headers: { Authorization: `Bot ${token}` },
  })
  if (!chRes.ok) throw new Error(`fetch channel failed: ${chRes.status}`)
  const channel = await chRes.json() as { guild_id?: string }
  const guildId = channel.guild_id
  if (!guildId) throw new Error("channel has no guild_id")

  const intent = extractDiscordResearchIntent(msg.content ?? "")
  if (intent.kind !== "research") {
    throw new Error(`not a research intent: ${JSON.stringify(intent)} content=${msg.content}`)
  }

  const accepted = await acceptDiscordRequest({
    guildId,
    channelId,
    messageId: msg.id,
    userId: msg.author.id,
    subject: intent.subject,
    ...(intent.chainHint ? { chainHint: intent.chainHint } : {}),
    ...(intent.tokenHint ? { tokenHint: intent.tokenHint } : {}),
  })
  console.log("accept:", JSON.stringify(accepted))

  if ("accepted" in accepted && !accepted.accepted && !("duplicate" in accepted)) {
    process.exitCode = 1
    return
  }

  for (;;) {
    const result = await processNextDiscordRequest({
      repoRoot: process.cwd(),
      token,
    })
    console.log("pump:", result)
    if (result === "idle" || result === "busy") break
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

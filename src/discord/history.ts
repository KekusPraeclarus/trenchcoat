import type { DiscordHistoryMessage, DiscordRestClient } from "./bot-client.js"

/** Paginate channel history newest→oldest pages, return chronological messages */
export async function fetchChannelWindow(args: Readonly<{
  client: DiscordRestClient
  channelId: string
  after?: string
  maxPages?: number
  onPage?: (args: Readonly<{
    messages: readonly DiscordHistoryMessage[]
    newestId?: string
  }>) => Promise<void>
}>): Promise<DiscordHistoryMessage[]> {
  if (!args.client.listChannelMessages) {
    throw new Error("discord client missing listChannelMessages")
  }
  const listChannelMessages = args.client.listChannelMessages.bind(args.client)
  const collected: DiscordHistoryMessage[] = []
  let after = args.after
  let pages = 0
  const maxPages = args.maxPages ?? Number.POSITIVE_INFINITY
  for (;;) {
    if (pages >= maxPages) break
    const page = await listChannelMessages({
      channelId: args.channelId,
      ...(after ? { after } : {}),
      limit: 100,
    })
    pages += 1
    if (page.length === 0) break
    const chronological = [...page].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    )
    collected.push(...chronological)
    const newestId = chronological[chronological.length - 1]?.id
    if (args.onPage) {
      await args.onPage({ messages: chronological, ...(newestId ? { newestId } : {}) })
    }
    if (!newestId || newestId === after) break
    after = newestId
    if (page.length < 100) break
  }
  return collected
}

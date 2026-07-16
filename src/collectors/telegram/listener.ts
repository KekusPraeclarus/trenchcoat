import { floodWaitMilliseconds, type TelegramPreviewMessage } from "./collector.js"

export type GramJsMessage = Readonly<{
  id: number
  channel: string
  text?: string
  date: Date
}>

export type GramJsListener = Readonly<{
  subscribe: (handler: (message: GramJsMessage) => Promise<void>) => Promise<void>
  sleep: (milliseconds: number) => Promise<void>
}>

export async function runGramJsListener(
  listener: GramJsListener,
  write: (message: TelegramPreviewMessage) => Promise<void>,
): Promise<void> {
  await listener.subscribe(async (message) => {
    if (!message.text) return
    try {
      await write({
        id: String(message.id),
        channel: message.channel,
        text: message.text,
        timestamp: message.date.toISOString(),
        url: `https://t.me/${message.channel}/${message.id}`,
        provenance: `telegram:${message.channel}`,
      })
    } catch (error) {
      const wait = floodWaitMilliseconds(error)
      if (wait === undefined) throw error
      await listener.sleep(wait)
    }
  })
}

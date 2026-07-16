export type TelegramMessage = Readonly<{
  updateId: number
  chatId: number
  userId: number
  text: string
}>

export type TelegramClient = Readonly<{
  getUpdates(offset: number, timeoutSeconds: number): Promise<readonly TelegramMessage[]>
  reply(chatId: number, text: string): Promise<void>
}>

export async function listenTelegram(
  client: TelegramClient,
  operatorId: string,
  idleTimeoutMinutes: number,
  handle: (message: TelegramMessage) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const allowedUserId = Number(operatorId)
  if (!Number.isSafeInteger(allowedUserId) || allowedUserId < 1) throw new TypeError("Telegram operator id is invalid")
  if (!Number.isInteger(idleTimeoutMinutes) || idleTimeoutMinutes < 1) throw new TypeError("Telegram idle timeout is invalid")

  let offset = 0
  let lastActivity = Date.now()
  while (!signal?.aborted && Date.now() - lastActivity < idleTimeoutMinutes * 60_000) {
    const messages = await client.getUpdates(offset, 25)
    for (const message of messages) {
      offset = Math.max(offset, message.updateId + 1)
      if (message.userId !== allowedUserId) continue
      lastActivity = Date.now()
      await handle(message)
    }
  }
}

export async function handleTelegramMessage(
  message: TelegramMessage,
  allowedUserId: number,
  handler: (message: TelegramMessage) => Promise<void>,
): Promise<void> {
  if (message.userId !== allowedUserId) return
  await handler(message)
}

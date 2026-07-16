export function isChatAllowed(userId: string, allowlist: readonly string[]): boolean {
  return allowlist.includes(userId)
}

export type ChatSender = (chatId: string, text: string) => Promise<void>

export async function handleChatUpdate(args: Readonly<{
  chatId: string
  userId: string
  text: string
  allowlist: readonly string[]
  send: ChatSender
}>): Promise<"ignored" | "replied"> {
  if (!isChatAllowed(args.userId, args.allowlist)) {
    return "ignored"
  }
  const reply = args.text.startsWith("/status")
    ? "trenchcoat online"
    : "acked — queueing research via host orchestrator"
  await args.send(args.chatId, reply)
  return "replied"
}

export type TelegramPreviewMessage = Readonly<{
  id: string
  text: string
  date: string
}>

export function parseTelegramPreviewHtml(html: string): TelegramPreviewMessage[] {
  const messages: TelegramPreviewMessage[] = []
  const re = /class="tgme_widget_message"[^>]*data-post="([^"]+)"[\s\S]*?class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/gu
  for (const match of html.matchAll(re)) {
    const id = match[1] ?? ""
    const text = (match[2] ?? "").replace(/<[^>]+>/gu, "").trim()
    if (id && text) {
      messages.push({ id, text, date: new Date().toISOString() })
    }
  }
  return messages
}

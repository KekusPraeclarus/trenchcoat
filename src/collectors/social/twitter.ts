export type TweetFixture = Readonly<{
  id: string
  text: string
  author: string
  createdAt: string
  url?: string
}>

export function parseTweetFixture(raw: unknown): TweetFixture[] {
  if (!Array.isArray(raw)) throw new TypeError("tweet fixture must be an array")
  return raw.map((row) => {
    const r = row as Record<string, unknown>
    return {
      id: String(r["id"] ?? ""),
      text: String(r["text"] ?? ""),
      author: String(r["author"] ?? ""),
      createdAt: String(r["createdAt"] ?? ""),
      ...(typeof r["url"] === "string" ? { url: r["url"] } : {}),
    }
  }).filter((t) => t.id && t.text)
}
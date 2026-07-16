import { assertSocialPermissions, type TrenchcoatConfig } from "../../lib/config.js"

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

export function assertTwitterPermission(config: TrenchcoatConfig): void {
  assertSocialPermissions(config)
  if (!config.twitter.scraping_permission_ref.trim()) {
    throw new Error("X scraping permission ref missing")
  }
}

/** Live Playwright burner session is operator-gated; refuse without permission ref. */
export async function refuseOrStartLiveScrape(config: TrenchcoatConfig): Promise<never> {
  assertTwitterPermission(config)
  throw new Error("Live X scrape requires headful auth via `tc auth twitter` (not implemented in unit path)")
}

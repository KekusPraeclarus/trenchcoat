import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { Browser, BrowserContext, Page } from "playwright"

export type TwitterSessionConfig = Readonly<{
  scrapingPermissionRef?: string
  profileDirectory: string
  headless?: boolean
}>

export type TwitterPost = Readonly<{
  id: string
  author: string
  text: string
  url: string
  timestamp: string
  provenance: string
}>

export function assertTwitterLivePermission(config: TwitterSessionConfig): string {
  if (!config.scrapingPermissionRef?.trim()) throw new Error("twitter.scraping_permission_ref is required for live scraping")
  const profile = resolve(config.profileDirectory)
  if (!existsSync(profile)) throw new Error("Twitter browser profile does not exist; headful re-auth is required")
  return profile
}

export async function openReadOnlyTwitterContext(
  browser: Browser,
  config: TwitterSessionConfig,
): Promise<BrowserContext> {
  const profile = assertTwitterLivePermission(config)
  const context = await browser.newContext({ storageState: resolve(profile, "storage-state.json") })
  await context.route("**/*", async (route) => {
    const method = route.request().method().toUpperCase()
    if (!["GET", "HEAD"].includes(method)) await route.abort("blockedbyclient")
    else await route.continue()
  })
  return context
}

export async function parseTwitterSearchPage(page: Page): Promise<TwitterPost[]> {
  return page.locator("article[data-testid='tweet']").evaluateAll((articles) => articles.slice(0, 100).flatMap((article) => {
    const link = article.querySelector("a[href*='/status/']")?.getAttribute("href")
    const text = article.querySelector("[data-testid='tweetText']")?.textContent
    const timestamp = article.querySelector("time")?.getAttribute("datetime")
    const author = article.querySelector("[data-testid='User-Name']")?.textContent?.match(/@([A-Za-z0-9_]{1,15})/)?.[1]
    const id = link?.match(/status\/(\d+)/)?.[1]
    if (!link || !text || !timestamp || !author || !id) return []
    return [{ id, author, text, timestamp, url: `https://x.com${link}`, provenance: `twitter:@${author}` }]
  }))
}

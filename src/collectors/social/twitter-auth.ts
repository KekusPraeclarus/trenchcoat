import { mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { chromium, type BrowserContext } from "playwright"
import { defaultConfigPath } from "../../lib/config.js"
import { ensureChromiumInstalled } from "../../lib/playwright-chromium.js"
import { clearXSessionHold, xSessionHoldPath } from "../twitter/session-hold.js"

export function twitterProfileDir(): string {
  return join(homedir(), ".trenchcoat", "twitter-profile")
}

export async function ensureTwitterProfileDir(): Promise<string> {
  const dir = twitterProfileDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(dir, "README.txt"),
    "Playwright persistent burner profile (host-only, never under agent/).\n"
      + "Created by: pnpm dev:cli auth twitter\n",
  )
  try { chmodSync(dir, 0o700) } catch { /* ignore */ }
  return dir
}

export function isTwitterAuthBlockedUrl(url: string): boolean {
  return /\/i\/flow\/login|\/account\/access|challenge/iu.test(url)
}

export function twitterAuthHomeReady(args: Readonly<{
  url: string
  homeUiCount: number
}>): boolean {
  if (args.homeUiCount <= 0) return false
  if (isTwitterAuthBlockedUrl(args.url)) return false
  return /(?:x|twitter)\.com\/home(?:[/?#]|$)/iu.test(args.url)
}

async function waitForLoggedIn(context: BrowserContext, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      const url = page.url()
      const home = await page.locator('[data-testid="AppTabBar_Home_Link"]').count().catch(() => 0)
      const primary = await page.locator('[data-testid="primaryColumn"]').count().catch(() => 0)
      const compose = await page.locator('[data-testid="SideNav_NewTweet_Button"]').count().catch(() => 0)
      if (twitterAuthHomeReady({ url, homeUiCount: home + primary + compose })) {
        return
      }
    }
    await new Promise((r) => setTimeout(r, 1_500))
  }
  throw new Error("Timed out waiting for X login (10 minutes). Re-run `pnpm dev:cli auth twitter`.")
}

/**
 * Headful burner login (INV documented exception). Operator logs in manually;
 * session persists under ~/.trenchcoat/twitter-profile — never under agent/.
 */
export async function authTwitterInteractive(): Promise<void> {
  const dir = await ensureTwitterProfileDir()

  if (!existsSync(defaultConfigPath())) {
    console.warn("warning: ~/.trenchcoat/config.json missing — run `pnpm dev:cli init` after auth")
  }

  ensureChromiumInstalled()

  console.log("")
  console.log("Opening headed Chromium for X/Twitter burner login.")
  console.log(`Profile: ${dir}`)
  console.log("1. Log in to the burner account in the browser window")
  console.log("2. Complete any account-access or Cloudflare check")
  console.log("3. Wait until you see the home timeline")
  console.log("4. This command saves only after the home UI is visible (up to 10 minutes)")
  console.log("   An existing auth_token cookie does not close the window.")
  console.log("")

  const context = await chromium.launchPersistentContext(dir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  })

  try {
    const page = context.pages()[0] ?? await context.newPage()
    await page.goto("https://x.com/i/flow/login", { waitUntil: "domcontentloaded", timeout: 60_000 })
    await waitForLoggedIn(context, 10 * 60_000)

    const statePath = join(dir, "storage-state.json")
    await context.storageState({ path: statePath })
    chmodSync(statePath, 0o600)

    // sanity: still have auth cookie
    const cookies = await context.cookies("https://x.com")
    const authed = cookies.some((c) => c.name === "auth_token" && c.value.length > 10)
    if (!authed) {
      throw new Error("Login UI appeared ready but auth_token cookie was missing — try again")
    }

    console.log("")
    console.log(`Saved burner session → ${statePath}`)
    console.log("Live scrapes will use this profile (read-only HTTP methods only).")
    if (clearXSessionHold(xSessionHoldPath())) {
      console.log("Cleared X session hold.")
      console.log("Start trenchcoat-x-scan after home loads.")
    }
  } finally {
    await context.close()
  }
}

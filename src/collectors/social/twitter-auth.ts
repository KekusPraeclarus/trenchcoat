import { mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { spawnSync } from "node:child_process"
import { chromium, type BrowserContext } from "playwright"
import { defaultConfigPath, loadConfig } from "../../lib/config.js"
import { log } from "../../lib/log.js"

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

function ensureChromiumInstalled(): void {
  const probe = spawnSync(
    process.execPath,
    ["-e", "require('playwright').chromium.executablePath()"],
    { encoding: "utf8" },
  )
  const path = (probe.stdout || "").trim()
  if (path && existsSync(path)) return

  log.info("installing playwright chromium")
  const install = spawnSync("pnpm", ["exec", "playwright", "install", "chromium"], {
    cwd: process.cwd(),
    stdio: "inherit",
  })
  if (install.status !== 0) {
    throw new Error("Failed to install Playwright Chromium — run: pnpm exec playwright install chromium")
  }
}

async function waitForLoggedIn(context: BrowserContext, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      const url = page.url()
      if (/x\.com\/(home|i\/flow\/login)/u.test(url) || /twitter\.com\/(home|i\/flow\/login)/u.test(url)) {
        const home = await page.locator('[data-testid="AppTabBar_Home_Link"]').count().catch(() => 0)
        const primary = await page.locator('[data-testid="primaryColumn"]').count().catch(() => 0)
        const compose = await page.locator('[data-testid="SideNav_NewTweet_Button"]').count().catch(() => 0)
        if (home + primary + compose > 0 && !url.includes("/i/flow/login")) {
          return
        }
      }
      // cookie presence is a strong signal even if UI is slow
      const cookies = await context.cookies("https://x.com")
      if (cookies.some((c) => c.name === "auth_token" && c.value.length > 10)) {
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
  console.log("2. Wait until you see the home timeline")
  console.log("3. This command saves the session automatically (up to 10 minutes)")
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
  } finally {
    await context.close()
  }
}

import { mkdirSync, writeFileSync, existsSync, chmodSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { chromium, type BrowserContext } from "playwright"
import { defaultConfigPath } from "../../lib/config.js"
import { ensureChromiumInstalled } from "../../lib/playwright-chromium.js"
import { authIssuesPath, clearAuthIssue } from "../../lib/auth-issues.js"

export function fomoProfileDir(): string {
  return join(homedir(), ".trenchcoat", "fomo-profile")
}

export async function ensureFomoProfileDir(): Promise<string> {
  const dir = fomoProfileDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(dir, "README.txt"),
    "Playwright persistent burner profile for fomo.family (host-only, never under agent/).\n"
      + "Created by: pnpm dev:cli auth fomo\n",
  )
  try { chmodSync(dir, 0o700) } catch { /* ignore */ }
  return dir
}

async function waitForFomoLoggedIn(context: BrowserContext, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      const url = page.url()
      if (/fomo\.family\/(login|signin)/iu.test(url)) continue
      try {
        const configOk = await page.waitForResponse(
          (response) => (
            response.url().includes("prod-api.fomo.family")
            && response.url().includes("/config")
            && response.status() === 200
          ),
          { timeout: 2_000 },
        ).then(() => true).catch(() => false)
        if (configOk) return
      } catch {
        // keep polling
      }
      const cookies = await context.cookies()
      const authed = cookies.some((cookie) => (
        /privy|session|token/iu.test(cookie.name) && cookie.value.length > 8
      ))
      if (authed && /fomo\.family/iu.test(url) && !/login|signin/iu.test(url)) {
        return
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  throw new Error("Timed out waiting for Fomo login (10 minutes). Re-run `pnpm dev:cli auth fomo`.")
}

/**
 * Headful burner login. Operator logs in manually; session persists under
 * ~/.trenchcoat/fomo-profile — never under agent/.
 */
export async function authFomoInteractive(): Promise<void> {
  const dir = await ensureFomoProfileDir()

  if (!existsSync(defaultConfigPath())) {
    console.warn("warning: ~/.trenchcoat/config.json missing — run `pnpm dev:cli init` after auth")
  }

  ensureChromiumInstalled()

  console.log("")
  console.log("Opening headed Chromium for fomo.family burner login.")
  console.log(`Profile: ${dir}`)
  console.log("1. Log in to the authorized zero-funds burner in the browser window")
  console.log("2. Wait until the authenticated app loads")
  console.log("3. This command saves the session automatically (up to 10 minutes)")
  console.log("")

  const context = await chromium.launchPersistentContext(dir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  })

  try {
    const page = context.pages()[0] ?? await context.newPage()
    await page.goto("https://fomo.family", { waitUntil: "domcontentloaded", timeout: 60_000 })
    await waitForFomoLoggedIn(context, 10 * 60_000)

    const statePath = join(dir, "storage-state.json")
    await context.storageState({ path: statePath })
    chmodSync(statePath, 0o600)

    console.log("")
    console.log(`Saved burner session → ${statePath}`)
    console.log("Live scrapes will use this profile (read-only HTTP methods only).")
    await clearAuthIssue({ path: authIssuesPath(), source: "fomo" })
  } finally {
    await context.close()
  }
}

export function assertFomoProfileReady(profileDirectory = fomoProfileDir()): string {
  const state = join(profileDirectory, "storage-state.json")
  if (!existsSync(state)) {
    throw new Error("No Fomo session — run `pnpm dev:cli auth fomo` first")
  }
  try {
    const raw = JSON.parse(readFileSync(state, "utf8")) as {
      cookies?: unknown[]
      origins?: unknown[]
    }
    if (!Array.isArray(raw.cookies) && !Array.isArray(raw.origins)) {
      throw new Error("malformed")
    }
  } catch {
    throw new Error("Fomo storage-state.json is malformed — re-run `pnpm dev:cli auth fomo`")
  }
  return state
}

export function fomoSessionExists(): boolean {
  try {
    assertFomoProfileReady()
    return true
  } catch {
    return false
  }
}

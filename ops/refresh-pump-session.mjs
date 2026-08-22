#!/usr/bin/env node
// Headless pump.fun session refresh for the Mac LaunchAgent.
// Lives under ~/.trenchcoat/bin so launchd does not read ~/Documents.
// Prints counts only. Never prints cookie or token values.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { join } from "node:path"
const IDENTITY_COOKIE = /^(privy-token|privy-id-token|privy-access-token)$/iu
const STATE_PATH = join(homedir(), ".trenchcoat", "pump-profile", "storage-state.json")
const SETTLE_MS = Number(process.env.TRENCHCOAT_PUMP_REFRESH_SETTLE_MS ?? 8000)

function cookiesLookAuthed(cookies) {
  return cookies.some((cookie) => (
    IDENTITY_COOKIE.test(String(cookie.name ?? "")) && String(cookie.value ?? "").length > 20
  ))
}

function originsLookAuthed(origins) {
  return (origins ?? []).some((origin) => (
    (origin.localStorage ?? []).some((item) => (
      /privy/iu.test(String(item.name ?? "")) && String(item.value ?? "").length > 40
    ))
  ))
}

function inspectState(raw) {
  const cookies = Array.isArray(raw?.cookies) ? raw.cookies : []
  const origins = Array.isArray(raw?.origins) ? raw.origins : []
  const localNames = new Set(
    origins.flatMap((origin) => (origin.localStorage ?? []).map((item) => item.name)),
  )
  return {
    cookieCount: cookies.length,
    localStorageCount: localNames.size,
    identityCookieCount: cookies.filter((cookie) => IDENTITY_COOKIE.test(String(cookie.name ?? ""))).length,
    looksAuthed: cookiesLookAuthed(cookies) || originsLookAuthed(origins),
  }
}

function resolvePlaywright() {
  const require = createRequire(import.meta.url)
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    join(homedir(), ".trenchcoat", "runtime", "node_modules", "playwright"),
    join(homedir(), ".trenchcoat", "runtime", "node_modules", "playwright-core"),
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch {
      /* try next */
    }
  }
  return null
}

function printInspect(label, inspect) {
  console.log(
    `${label} looks_authed=${inspect.looksAuthed} cookies=${inspect.cookieCount}`
      + ` identity_cookies=${inspect.identityCookieCount}`
      + ` localStorage=${inspect.localStorageCount}`,
  )
}

if (!existsSync(STATE_PATH)) {
  console.error("No pump.fun session — run `pnpm dev:cli auth pump` first")
  process.exit(2)
}

const before = inspectState(JSON.parse(readFileSync(STATE_PATH, "utf8")))
printInspect("before", before)

const playwright = resolvePlaywright()
if (!playwright?.chromium) {
  console.error("refresh skipped: playwright is not in ~/.trenchcoat/runtime")
  process.exit(3)
}

const browser = await playwright.chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
})
try {
  const context = await browser.newContext({
    storageState: STATE_PATH,
    viewport: { width: 1280, height: 900 },
  })
  try {
    const page = await context.newPage()
    await page.goto("https://pump.fun", { waitUntil: "domcontentloaded", timeout: 60_000 })
    const deadline = Date.now() + SETTLE_MS
    while (Date.now() < deadline) {
      if (cookiesLookAuthed(await context.cookies())) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const next = await context.storageState()
    const after = inspectState(next)
    printInspect("after", after)
    if (!after.looksAuthed) {
      console.error("refresh left no Privy identity token — skip write")
      process.exit(2)
    }
    writeFileSync(STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    chmodSync(STATE_PATH, 0o600)
    console.log(`wrote ${STATE_PATH}`)
  } finally {
    await context.close()
  }
} finally {
  await browser.close()
}

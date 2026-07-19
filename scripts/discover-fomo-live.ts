/**
 * Capture authenticated prod-api traffic from /token with read POST allowlist.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { chromium } from "playwright"
import { assertFomoProfileReady, fomoProfileDir } from "../src/collectors/social/fomo-auth.js"

const READ_POST_PREFIXES = [
  "/v2/users",
  "/v2/leaderboard",
  "/v2/userTokens",
  "/proxy/",
  "/feed/",
  "/hodlers/",
  "/watchlist",
]

function allowPost(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.hostname === "auth.privy.io") return true
    if (u.hostname !== "prod-api.fomo.family") return false
    return READ_POST_PREFIXES.some((p) => u.pathname === p || u.pathname.startsWith(p))
  } catch {
    return false
  }
}

const outDir = join(homedir(), ".trenchcoat", "probes", "fomo", "discover-live-2026-07-19")
mkdirSync(outDir, { recursive: true, mode: 0o700 })
assertFomoProfileReady(fomoProfileDir())

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  storageState: assertFomoProfileReady(),
  viewport: { width: 1440, height: 900 },
})

await context.route("**/*", async (route) => {
  const req = route.request()
  const url = req.url()
  const method = req.method().toUpperCase()
  if (/walletconnect|moonpay|alchemy|helius-rpc|googletagmanager|google-analytics|posthog|app-actions/i.test(url)) {
    await route.abort("blockedbyclient")
    return
  }
  if (method === "GET" || method === "HEAD") {
    await route.continue()
    return
  }
  if (allowPost(url)) {
    await route.continue()
    return
  }
  await route.abort("blockedbyclient")
})

const hits: Array<{ method: string, url: string, status: number, bytes: number, preview: string }> = []
const page = await context.newPage()
page.on("response", async (response) => {
  const url = response.url()
  if (!/prod-api\.fomo\.family/i.test(url)) return
  const body = await response.text().catch(() => "")
  hits.push({
    method: response.request().method(),
    url: url.slice(0, 300),
    status: response.status(),
    bytes: body.length,
    preview: body.slice(0, 300).replace(/\s+/g, " "),
  })
})

await page.goto("https://fomo.family/token", { waitUntil: "domcontentloaded", timeout: 45_000 })
await page.waitForTimeout(12_000)
await page.screenshot({ path: join(outDir, "token-allowed.png") })

const info = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  body: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 600),
}))

// try friends/leaderboard UI labels
for (const name of ["Leaderboard", "Friends", "Feed", "Alerts", "Following"]) {
  const loc = page.getByText(name, { exact: false }).first()
  if (await loc.count()) {
    try {
      await loc.click({ timeout: 1_500 })
      await page.waitForTimeout(3_000)
    } catch {
      // ignore
    }
  }
}

writeFileSync(join(outDir, "token-api-hits.json"), JSON.stringify({ info, hits }, null, 2), { mode: 0o600 })
console.log(JSON.stringify({
  info,
  hitCount: hits.length,
  paths: [...new Set(hits.map((h) => {
    try { return `${h.method} ${new URL(h.url).pathname}` } catch { return h.url }
  }))],
  samples: hits.slice(0, 12).map((h) => ({
    method: h.method,
    path: (() => { try { return new URL(h.url).pathname } catch { return h.url } })(),
    status: h.status,
    bytes: h.bytes,
    preview: h.preview.slice(0, 120),
  })),
}, null, 2))
await browser.close()

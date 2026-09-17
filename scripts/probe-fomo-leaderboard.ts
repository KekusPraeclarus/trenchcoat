/**
 * Read-only FOMO leaderboard probe. Finds the live 7d leaderboard API path.
 * Does not click trade or follow. Prints routes, buttons, and JSON keys.
 */
import { assertFomoProfileReady } from "../src/collectors/social/fomo-auth.js"
import { classifyFomoRequest, FOMO_BOOT_PATH } from "../src/collectors/fomo/request-policy.js"
import { launchChromium } from "../src/lib/playwright-chromium.js"

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const PATHS = [
  FOMO_BOOT_PATH,
  "/leaderboard",
  "/traders",
  "/friends",
  "/pnl",
  "/top",
]

type Hit = Readonly<{
  method: string
  url: string
  status?: number
  keys?: string[]
  itemCount?: number
  nestedKeys?: string[]
  blocked?: boolean
  reason?: string
}>

function summarizeBody(body: unknown): Readonly<{
  keys: string[]
  itemCount?: number
  nestedKeys?: string[]
}> {
  if (Array.isArray(body)) return { keys: ["<array>"], itemCount: body.length }
  if (!body || typeof body !== "object") return { keys: [typeof body] }
  const record = body as Record<string, unknown>
  const keys = Object.keys(record).slice(0, 24)
  const nested = record["responseObject"]
  const nestedKeys = nested && typeof nested === "object" && !Array.isArray(nested)
    ? Object.keys(nested as Record<string, unknown>).slice(0, 24)
    : undefined
  let itemCount: number | undefined
  const search = [record, ...(nested && typeof nested === "object" ? [nested as Record<string, unknown>] : [])]
  for (const row of search) {
    for (const key of ["leaderboard", "traders", "users", "items", "data", "responseObject"]) {
      const value = row[key]
      if (Array.isArray(value)) {
        itemCount = value.length
        break
      }
    }
    if (itemCount !== undefined) break
  }
  return {
    keys,
    ...(nestedKeys ? { nestedKeys } : {}),
    ...(itemCount !== undefined ? { itemCount } : {}),
  }
}

async function main(): Promise<void> {
  const waitMs = Number(process.argv[2] ?? 8_000)
  const hits: Hit[] = []
  const nav: Array<Readonly<{ path: string, url: string, buttons: string[], body: string }>> = []

  const browser = await launchChromium({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  })
  const context = await browser.newContext({
    storageState: assertFomoProfileReady(),
    viewport: { width: 1440, height: 900 },
    userAgent: USER_AGENT,
  })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined })
  })
  await context.route("**/*", async (route) => {
    const request = route.request()
    const url = request.url()
    const decision = classifyFomoRequest(request.method(), url)
    if (/walletconnect|moonpay|alchemy|helius-rpc|rpc\./iu.test(url)) {
      await route.abort("blockedbyclient")
      return
    }
    if (/prod-api\.fomo\.family\/.*leaderboard|\/v2\/leaderboard/iu.test(url)) {
      hits.push({
        method: request.method(),
        url: url.slice(0, 240),
        blocked: !decision.allow,
        reason: decision.reason,
      })
    }
    await route.continue()
  })

  const page = await context.newPage()
  page.on("response", (response) => {
    const url = response.url()
    if (!/prod-api\.fomo\.family/iu.test(url)) return
    if (!/leaderboard|traders|friends|pnl/iu.test(url)) return
    void response.text().then((text) => {
      try {
        const parsed = JSON.parse(text) as unknown
        const summary = summarizeBody(parsed)
        hits.push({
          method: "RESP",
          url: url.slice(0, 240),
          status: response.status(),
          ...summary,
        })
      } catch {
        hits.push({
          method: "RESP",
          url: url.slice(0, 240),
          status: response.status(),
          keys: ["<non-json>"],
        })
      }
    }).catch(() => undefined)
  })

  for (const path of PATHS) {
    await page.goto(`https://fomo.family${path}`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    })
    await page.waitForTimeout(waitMs)
    await page.evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll(".mobile-blocker"))
      for (const el of nodes) el.setAttribute("style", "display:none")
    })()`)
    const dump = await page.evaluate(`(() => {
      const textOf = (el) => (el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80)
      return {
        url: location.href,
        buttons: [...document.querySelectorAll("button, a, [role='button'], [role='tab']")].map(textOf).filter((text) => text.length > 0).slice(0, 50),
        body: (document.body && document.body.innerText ? document.body.innerText : "").slice(0, 400),
      }
    })()`) as { url: string, buttons: string[], body: string }
    nav.push({ path, ...dump })

    const control = page.getByRole("button", { name: /leaderboard|traders|top|7d|friends/iu }).first()
    if (await control.count() > 0) {
      await control.click({ timeout: 5_000 }).catch(() => undefined)
      await page.waitForTimeout(4_000)
    }
  }

  const apiPaths = [...new Set(
    hits
      .map((hit) => {
        try {
          const parsed = new URL(hit.url)
          return `${hit.method} ${parsed.hostname}${parsed.pathname}`
        } catch {
          return `${hit.method} ${hit.url}`
        }
      }),
  )]

  console.log(JSON.stringify({
    waitMs,
    nav,
    apiPaths,
    hits: hits.slice(0, 80),
  }, null, 2))

  await context.close()
  await browser.close()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

/**
 * Read-only FOMO alerts probe. Finds the live alerts API path.
 * Does not click trade or follow. Prints routes, blocked posts, and JSON keys.
 */
import { assertFomoProfileReady } from "../src/collectors/social/fomo-auth.js"
import { classifyFomoRequest, FOMO_BOOT_PATH } from "../src/collectors/fomo/request-policy.js"
import { launchChromium } from "../src/lib/playwright-chromium.js"

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const PATHS = [
  FOMO_BOOT_PATH,
  "/alerts",
  "/notifications",
  "/watchlist",
  "/activity",
  "/feed",
]

type Hit = Readonly<{
  method: string
  url: string
  status?: number
  keys?: string[]
  itemCount?: number
  blocked?: boolean
  reason?: string
}>

function summarizeBody(body: unknown): Readonly<{ keys: string[], itemCount?: number }> {
  if (Array.isArray(body)) return { keys: ["<array>"], itemCount: body.length }
  if (!body || typeof body !== "object") return { keys: [typeof body] }
  const record = body as Record<string, unknown>
  const keys = Object.keys(record).slice(0, 20)
  let itemCount: number | undefined
  for (const key of ["alerts", "notifications", "items", "data", "responseObject"]) {
    const value = record[key]
    if (Array.isArray(value)) {
      itemCount = value.length
      break
    }
    if (value && typeof value === "object") {
      const nested = value as Record<string, unknown>
      for (const inner of ["alerts", "notifications", "items", "data"]) {
        if (Array.isArray(nested[inner])) {
          itemCount = (nested[inner] as unknown[]).length
          break
        }
      }
    }
  }
  return { keys, ...(itemCount !== undefined ? { itemCount } : {}) }
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
    if (/prod-api\.fomo\.family|alert|notif/iu.test(url)) {
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
        buttons: [...document.querySelectorAll("button, a, [role='button']")].map(textOf).filter((text) => text.length > 0).slice(0, 40),
        body: (document.body && document.body.innerText ? document.body.innerText : "").slice(0, 400),
      }
    })()`) as { url: string, buttons: string[], body: string }
    nav.push({ path, ...dump })

    const alertControl = page.getByRole("button", { name: /alert|notif/iu }).first()
    if (await alertControl.count() > 0) {
      await alertControl.click({ timeout: 5_000 }).catch(() => undefined)
      await page.waitForTimeout(3_000)
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

/**
 * Read-only FOMO profile probe for the follow control.
 * Does not click. Prints roles, labels, assets, and blocked requests.
 */
import { assertFomoProfileReady, fomoProfileDir } from "../src/collectors/social/fomo-auth.js"
import { classifyFomoRequest } from "../src/collectors/fomo/request-policy.js"
import { launchChromium } from "../src/lib/playwright-chromium.js"

const BOOT_PATH = "/tokens/solana/2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv"
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

const PAGE_DUMP = `(() => {
  const textOf = (el) => (el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80)
  return {
    url: location.href,
    title: document.title,
    buttonCount: document.querySelectorAll("button").length,
    body: (document.body && document.body.innerText ? document.body.innerText : "").slice(0, 800),
    root: (document.getElementById("root") || document.getElementById("app") || document.body).innerHTML.slice(0, 500),
    scripts: [...document.querySelectorAll("script")].map((el) => ({
      type: el.getAttribute("type") || "",
      src: el.getAttribute("src") || "",
    })).filter((row) => row.src || /module/i.test(row.type)).slice(0, 30),
    preloads: [...document.querySelectorAll("link[rel='modulepreload'], link[rel='preload']")].map((el) => el.getAttribute("href") || "").slice(0, 30),
    allButtons: [...document.querySelectorAll("button, [role='button']")].map(textOf).slice(0, 40),
  }
})()`

async function main(): Promise<void> {
  const handle = (process.argv[2] ?? "frankdegods").trim().replace(/^@/u, "")
  const waitMs = Number(process.argv[3] ?? 8_000)
  const openSpa = process.argv.includes("--open-spa")
  const bootFirst = process.argv.includes("--boot")
  const clickFollow = process.argv.includes("--click")

  const storageState = assertFomoProfileReady(fomoProfileDir())
  const blocked: string[] = []
  const allowedMutations: string[] = []
  const apiHits: string[] = []
  const assetHits: string[] = []
  const userPayloads: string[] = []

  const browser = await launchChromium({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  })
  const context = await browser.newContext({
    storageState,
    viewport: { width: 1440, height: 900 },
    userAgent: USER_AGENT,
  })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined })
  })
  await context.route("**/*", async (route) => {
    const request = route.request()
    const url = request.url()
    const decision = classifyFomoRequest(request.method(), url, {
      mutationMode: true,
    })
    const line = `${request.method()} ${url.slice(0, 220)} ${decision.reason}`
    if (/prod-api|app-actions|follow|friend|featureassets|statsig|userHandle/iu.test(url)) {
      apiHits.push(line)
    }
    if (/fomo\.family\/assets\//iu.test(url)) {
      assetHits.push(`${request.method()} ${url}`)
    }
    if (openSpa) {
      if (/walletconnect|moonpay|alchemy|helius-rpc|rpc\./iu.test(url)) {
        blocked.push(`forced-block ${line}`)
        await route.abort("blockedbyclient")
        return
      }
      if (!decision.allow) blocked.push(`would-block ${line}`)
      await route.continue()
      return
    }
    if (!decision.allow) {
      blocked.push(line)
      await route.abort("blockedbyclient")
      return
    }
    if (decision.reason.startsWith("allowed-follow")) allowedMutations.push(line)
    await route.continue()
  })

  const page = await context.newPage()
  page.on("response", (response) => {
    const url = response.url()
    if (!/userHandle|v2\/users/iu.test(url)) return
    void response.text().then((text) => {
      userPayloads.push(`${response.status()} ${url.slice(0, 180)} ${text.slice(0, 500)}`)
    }).catch(() => undefined)
  })

  if (bootFirst) {
    await page.goto(`https://fomo.family${BOOT_PATH}`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    })
    await page.waitForTimeout(waitMs)
  }

  await page.goto(`https://fomo.family/profile/${encodeURIComponent(handle)}`, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  })
  await page.waitForTimeout(waitMs)
  await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll(".mobile-blocker"))
    for (const el of nodes) el.setAttribute("style", "display:none")
  })

  let clickError: string | undefined
  if (clickFollow) {
    try {
      await page.getByRole("button", { name: /^follow$/iu }).first().click({ timeout: 20_000 })
      await page.waitForTimeout(2_500)
    } catch (error) {
      clickError = error instanceof Error ? error.message : String(error)
    }
  }

  const dump = await page.evaluate(PAGE_DUMP) as {
    url: string
    title: string
    buttonCount: number
    body: string
    root: string
    scripts: Array<{ type: string, src: string }>
    preloads: string[]
    allButtons: string[]
  }

  console.log(JSON.stringify({
    handle,
    openSpa,
    bootFirst,
    clickFollow,
    clickError: clickError ?? null,
    waitMs,
    url: dump.url,
    title: dump.title,
    buttonCount: dump.buttonCount,
    body: dump.body,
    root: dump.root,
    scripts: dump.scripts,
    preloads: dump.preloads,
    allButtons: dump.allButtons,
    userPayloads: userPayloads.slice(-8),
    followHits: apiHits.filter((line) => /follow|following/iu.test(line)).slice(0, 20),
    assetHits: assetHits.slice(0, 20),
    apiHits: apiHits.slice(-20),
    blockedCount: blocked.length,
    blockedSample: blocked.slice(0, 12),
    allowedMutations,
  }, null, 2))

  await context.close()
  await browser.close()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

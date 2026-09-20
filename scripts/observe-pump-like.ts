/**
 * Read-only live observe of pump.fun FYP card markup and POST paths.
 * Does not click like/follow. Gated by TRENCHCOAT_LIVE_PUMP=1.
 */
import { assertPumpProfileReady } from "../src/collectors/social/pump-auth.js"
import { classifyPumpDiscoverObserve } from "../src/collectors/pump/request-policy.js"
import { ensureChromiumInstalled, launchChromium } from "../src/lib/playwright-chromium.js"

function redact(value: string): string {
  return value
    .replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/gu, ":id")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, ":uuid")
}

async function main(): Promise<void> {
  if (process.env["TRENCHCOAT_LIVE_PUMP"] !== "1") {
    console.error("Set TRENCHCOAT_LIVE_PUMP=1 to observe pump.fun cards")
    process.exit(2)
  }
  assertPumpProfileReady()
  ensureChromiumInstalled()
  const browser = await launchChromium({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  })
  const context = await browser.newContext({
    storageState: assertPumpProfileReady(),
    viewport: { width: 1440, height: 900 },
  })
  const posts: Array<Readonly<{ method: string, host: string, path: string, decision: string }>> = []
  await context.route("**/*", async (route) => {
    const request = route.request()
    const decision = classifyPumpDiscoverObserve(request.method(), request.url())
    let host = "invalid"
    let path = ""
    try {
      const parsed = new URL(request.url())
      host = parsed.hostname
      path = parsed.pathname
    } catch {
      host = "invalid"
    }
    const verb = request.method().toUpperCase()
    if (verb !== "GET" && verb !== "HEAD") {
      posts.push({
        method: verb,
        host,
        path: redact(path),
        decision: decision.reason,
      })
    }
    if (!decision.allow) {
      await route.abort("blockedbyclient")
      return
    }
    await route.continue()
  })
  const page = await context.newPage()
  await page.goto("https://pump.fun/", { waitUntil: "domcontentloaded", timeout: 45_000 })
  await page.waitForTimeout(4_000)
  await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2))
  await page.waitForTimeout(2_500)

  const snapshot = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button, [role=button]")).slice(0, 80).map((el) => (
      ((el.getAttribute("aria-label") ?? el.textContent ?? "").trim()).slice(0, 48)
    ))
    const hrefs = Array.from(document.querySelectorAll("a[href]"))
      .map((a) => a.getAttribute("href") ?? "")
      .filter((href) => href.includes("/") && href.length < 180)
      .slice(0, 40)
    const likeEls = Array.from(document.querySelectorAll("[data-testid='callout-action-like']"))
    const likeControls = likeEls.slice(0, 4).map((el) => {
      let node: Element | null = el
      let nearestCallout = ""
      for (let i = 0; i < 12 && node; i += 1) {
        const found = node.querySelector("a[href*='/callouts/']")
        if (found) {
          nearestCallout = found.getAttribute("href") ?? ""
          break
        }
        node = node.parentElement
      }
      return {
        aria: el.getAttribute("aria-label"),
        testid: el.getAttribute("data-testid"),
        nearestCallout,
      }
    })
    return { buttons, hrefs, likeCount: likeEls.length, likeControls }
  })

  const uniquePosts = [...new Map(posts.map((p) => [`${p.method}:${p.host}${p.path}`, p])).values()]
  console.log(JSON.stringify({
    url: redact(page.url()),
    likeCount: snapshot.likeCount,
    likeControls: snapshot.likeControls.map((row) => ({
      ...row,
      nearestCallout: redact(row.nearestCallout),
    })),
    buttonNames: [...new Set(snapshot.buttons.filter(Boolean))].slice(0, 40),
    hrefShapes: [...new Set(snapshot.hrefs.map(redact))].slice(0, 30),
    posts: uniquePosts.slice(0, 24),
  }, null, 2))
  await context.close()
  await browser.close()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})

/**
 * One-shot live like against a visible FYP callout.
 * Gated by TRENCHCOAT_LIVE_PUMP=1. Does not write agent state.
 */
import { assertPumpProfileReady } from "../src/collectors/social/pump-auth.js"
import { PumpEngagementSession } from "../src/collectors/pump/engagement.js"
import { classifyPumpDiscoverObserve } from "../src/collectors/pump/request-policy.js"
import { ensureChromiumInstalled, launchChromium } from "../src/lib/playwright-chromium.js"

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu

async function firstVisibleCalloutId(): Promise<string | null> {
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
  await context.route("**/*", async (route) => {
    const request = route.request()
    const decision = classifyPumpDiscoverObserve(request.method(), request.url())
    if (!decision.allow) {
      await route.abort("blockedbyclient")
      return
    }
    await route.continue()
  })
  const page = await context.newPage()
  try {
    await page.goto("https://pump.fun/", { waitUntil: "domcontentloaded", timeout: 45_000 })
    await page.waitForTimeout(4_000)
    await page.getByRole("button", { name: "Dismiss" }).click({ timeout: 2_000 }).catch(() => undefined)
    const href = await page.locator("a[href*='/callouts/']").first().getAttribute("href")
    const match = href?.match(UUID_RE)
    return match?.[0] ?? null
  } finally {
    await context.close()
    await browser.close()
  }
}

async function main(): Promise<void> {
  if (process.env["TRENCHCOAT_LIVE_PUMP"] !== "1") {
    console.error("Set TRENCHCOAT_LIVE_PUMP=1 to run live pump.fun like smoke")
    process.exit(2)
  }
  const itemId = await firstVisibleCalloutId()
  if (!itemId) {
    console.log(JSON.stringify({ found: false, verified: false, ambiguous: true }))
    process.exitCode = 2
    return
  }
  const session = new PumpEngagementSession()
  try {
    const result = await session.like(itemId)
    console.log(JSON.stringify({ found: true, verified: result.verified, ambiguous: result.ambiguous }))
    if (!result.verified) process.exitCode = 1
  } finally {
    await session.close()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})

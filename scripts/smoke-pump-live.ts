/**
 * One-shot live smoke against the burner pump.fun session.
 * Gated by TRENCHCOAT_LIVE_PUMP=1. Does not install gates.
 */
import { join } from "node:path"
import { homedir } from "node:os"
import { PumpWebClient } from "../src/collectors/pump/web-client.js"
import { pumpSessionExists } from "../src/collectors/social/pump-auth.js"

async function main(): Promise<void> {
  if (process.env["TRENCHCOAT_LIVE_PUMP"] !== "1") {
    console.error("Set TRENCHCOAT_LIVE_PUMP=1 to run live pump.fun smoke")
    process.exit(2)
  }
  const archiveRoot = join(homedir(), ".trenchcoat", "archive")
  const out: {
    session: boolean
    fyp: number
    top: number
    news: number
    leaderboard: number
    error: string | null
  } = {
    session: pumpSessionExists(),
    fyp: 0,
    top: 0,
    news: 0,
    leaderboard: 0,
    error: null,
  }
  if (!out.session) {
    console.log(JSON.stringify({ ...out, error: "missing-session" }, null, 2))
    process.exit(1)
  }

  const client = new PumpWebClient({
    archiveRoot,
    dailyNavigationBudget: 40,
    minDelayMs: 800,
    maxDelayMs: 1_200,
    headless: true,
    maxPagesPerFeed: 1,
    debitAttempts: false,
  })
  try {
    const fyp = await client.readFeed({ tab: "fyp", maxPages: 1 })
    out.fyp = fyp.length
    const top = await client.readFeed({ tab: "top", maxPages: 1 })
    out.top = top.length
    const news = await client.readFeed({ tab: "news", maxPages: 1 })
    out.news = news.length
    const lb = await client.readLeaderboard({ maxHandles: 20 })
    out.leaderboard = lb.length
    const capture = client.takeCaptureLog().filter((hit) => (
      hit.status === 0
      || /mints|users\/batch|callout|leaderboard/iu.test(hit.path)
    )).slice(0, 16)
    if (out.top === 0 || out.news === 0 || out.leaderboard === 0) {
      console.log(JSON.stringify({
        ...out,
        capture,
        hint: "zero tabs still list JSON paths and key names only",
      }, null, 2))
    } else {
      console.log(JSON.stringify(out, null, 2))
    }
    if (out.fyp + out.top + out.news + out.leaderboard === 0) {
      process.exitCode = 2
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "err"
    const message = error instanceof Error ? error.message : String(error)
    out.error = `${code}: ${message}`
    console.log(JSON.stringify(out, null, 2))
    process.exitCode = 1
  } finally {
    await client.close()
  }
}

await main()

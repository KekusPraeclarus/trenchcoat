/**
 * One-shot live smoke against the burner Fomo session.
 * Does not install gates. Exit 0 only if session works and at least one
 * of leaderboard/feed/trending returns without client error.
 */
import { join } from "node:path"
import { homedir } from "node:os"
import { FomoWebClient } from "../src/collectors/fomo/web-client.js"
import { fomoSessionExists } from "../src/collectors/social/fomo-auth.js"

async function main(): Promise<void> {
  const archiveRoot = join(homedir(), ".trenchcoat", "archive")
  const out: {
    session: boolean
    leaderboard: number
    feed: number
    trending: number
    error: string | null
    sampleHandles: unknown[]
    sampleFeed: unknown[]
    sampleTrending: unknown[]
  } = {
    session: fomoSessionExists(),
    leaderboard: 0,
    feed: 0,
    trending: 0,
    error: null,
    sampleHandles: [],
    sampleFeed: [],
    sampleTrending: [],
  }
  if (!out.session) {
    console.log(JSON.stringify({ ...out, error: "missing-session" }, null, 2))
    process.exit(1)
  }

  const client = new FomoWebClient({
    archiveRoot,
    dailyNavigationBudget: 200,
    minDelayMs: 800,
    maxDelayMs: 1_200,
    headless: true,
  })
  try {
    const lb = await client.readLeaderboard({ timeframe: "7d", limit: 20 })
    out.leaderboard = lb.length
    out.sampleHandles = lb.slice(0, 3).map((t) => ({
      handle: t.handle,
      wallets: t.wallets.length,
      x: t.xHandle ?? null,
    }))
    const feed = await client.readFeed({ limit: 20 })
    out.feed = feed.length
    out.sampleFeed = feed.slice(0, 2).map((e) => ({
      handle: e.handle,
      action: e.action,
      mint: e.tokenMint?.slice(0, 8),
    }))
    const trending = await client.readTrending({ limit: 10 })
    out.trending = trending.length
    out.sampleTrending = trending.slice(0, 3).map((t) => ({
      symbol: t.symbol,
      mint: t.tokenMint?.slice(0, 8),
    }))
    console.log(JSON.stringify(out, null, 2))
    if (out.leaderboard + out.feed + out.trending === 0) {
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

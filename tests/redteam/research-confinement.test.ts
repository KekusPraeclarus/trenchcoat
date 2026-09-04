import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { extractResearchIntent } from "../../src/chat/research-intent.js"
import { WebSearchRequestFileSchema } from "../../src/contracts/schemas.js"
import { SCRUBBED_CHILD_ENV_KEYS } from "../../src/orchestrator/session.js"
import {
  buildResearchTwitterQueries,
  twitterSearchUrl,
} from "../../src/collectors/twitter/popularity.js"

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const st = statSync(path)
    if (st.isDirectory()) walk(path, out)
    else if (entry.endsWith(".ts")) out.push(path)
  }
  return out
}

describe("research confinement redteam", () => {
  it("src/chat has no fetch and no collector imports", () => {
    const files = walk(join(process.cwd(), "src/chat"))
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      expect(text).not.toMatch(/\bfetch\s*\(/u)
      expect(text).not.toMatch(/collectors\//u)
      expect(text).not.toMatch(/TAVILY_API_KEY/u)
    }
  })

  it("web-search requests never authorize model-selected URLs as fetch targets", () => {
    const parsed = WebSearchRequestFileSchema.parse({
      schema: 1,
      runId: "research-1",
      requests: [{ query: "site:x.com BONK", reason: "social" }],
    })
    expect(parsed.requests[0]?.query.startsWith("http")).toBe(false)
    // Host Tavily collector builds api.tavily.com URLs only — see tavily.ts
    const tavily = readFileSync(
      join(process.cwd(), "src/collectors/web/tavily.ts"),
      "utf8",
    )
    expect(tavily).toContain("api.tavily.com")
    expect(tavily).not.toMatch(/new URL\(args\.|new URL\(request/u)
  })

  it("research intent cannot launch without an explicit confirm path", () => {
    const intent = extractResearchIntent("research BONK")
    expect(intent.kind).toBe("research")
    // Intent alone is not a queue mutation — only pending-research confirm is
    expect(intent).not.toHaveProperty("queueId")
  })

  it("scrubs Tavily key from Cursor child env", () => {
    expect(SCRUBBED_CHILD_ENV_KEYS).toContain("TAVILY_API_KEY")
    expect(SCRUBBED_CHILD_ENV_KEYS).toContain("INTAKE_WEBHOOK_URL")
    expect(SCRUBBED_CHILD_ENV_KEYS).toContain("INTAKE_SENDER_KEY")
  })

  it("research twitter search URLs are host-built and never from tweet text", () => {
    const queries = buildResearchTwitterQueries({
      chain: "solana",
      tokenAddress: "So11111111111111111111111111111111111111112",
      pairAddress: "So11111111111111111111111111111111111111112",
      symbolDisplay: "SOL",
      resolution: "resolved",
    })
    for (const q of queries) {
      const url = twitterSearchUrl(q.query)
      expect(url.startsWith("https://x.com/search?q=")).toBe(true)
      expect(url).not.toMatch(/javascript:/iu)
    }
    const scrape = readFileSync(
      join(process.cwd(), "src/collectors/twitter/scrape.ts"),
      "utf8",
    )
    expect(scrape).toContain("scrapeResearchTokenTwitter")
    expect(scrape).toMatch(/GET.*HEAD.*OPTIONS/u)
  })
})

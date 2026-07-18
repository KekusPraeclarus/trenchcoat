import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  buildCursorCliArgs,
  assertPathOnlyPrompt,
  resolveCursorCliBin,
  scrubChildEnv,
  SCRUBBED_CHILD_ENV_KEYS,
} from "../../src/orchestrator/session.js"

describe("cursor cli session", () => {
  it("builds headless login-auth argv without requiring an api key", () => {
    const args = buildCursorCliArgs({
      prompt: "Read inbox/run-1/meta.json by path only",
      cwd: "/tmp/agent",
      sandbox: true,
    })
    expect(args).toEqual([
      "-p",
      "Read inbox/run-1/meta.json by path only",
      "--output-format",
      "text",
      "--trust",
      "--workspace",
      "/tmp/agent",
      "--model",
      "composer-2.5",
      "--sandbox",
      "enabled",
    ])
    expect(args.includes("--api-key")).toBe(false)
  })

  it("includes ask mode and resume for chat turns", () => {
    const args = buildCursorCliArgs({
      prompt: "Follow skills/chat/SKILL.md",
      cwd: "/tmp/agent",
      sandbox: true,
      mode: "ask",
      resumeChatId: "11111111-2222-3333-4444-555555555555",
      outputFormat: "stream-json",
      streamPartial: true,
    })
    expect(args).toContain("--mode")
    expect(args).toContain("ask")
    expect(args).toContain("--resume")
    expect(args).toContain("11111111-2222-3333-4444-555555555555")
    expect(args).toContain("stream-json")
    expect(args).toContain("--stream-partial-output")
  })

  it("resolves a binary name", () => {
    expect(resolveCursorCliBin()).toMatch(/agent/u)
  })

  it("rejects secret-bearing prompts", () => {
    expect(() => assertPathOnlyPrompt("leak CURSOR_API_KEY now")).toThrow(/secrets/u)
  })

  it("production session launchers use login auth only (no CURSOR_API_KEY argv)", () => {
    const root = process.cwd()
    for (const rel of ["src/orchestrator/run.ts", "src/chat/session.ts"]) {
      const src = readFileSync(join(root, rel), "utf8")
      expect(src, rel).not.toMatch(/CURSOR_API_KEY/u)
      expect(src, rel).not.toMatch(/apiKey:\s*process\.env/u)
    }
  })
})

describe("prop_inv_i3_scrub_child_env", () => {
  it("drops every known host credential from the Cursor child env", () => {
    const polluted: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/Users/test",
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "b",
      CURSOR_API_KEY: "c",
      TRENCHCOAT_ROUTER_URL: "http://127.0.0.1:8787",
      TRENCHCOAT_ROUTER_TOKEN: "tok",
      TRENCHCOAT_ROUTER_HMAC_KEY: "hmac",
      TELEGRAM_BOT_TOKEN: "tg",
      TELEGRAM_OPERATOR_ID: "1",
      TELEGRAM_ROUTER_BOT_TOKEN: "rtg",
      TELEGRAM_ROUTER_CHAT_ID: "2",
      TELEGRAM_API_ID: "3",
      TELEGRAM_API_HASH: "hash",
      GOPLUS_APP_KEY: "gp",
      GOPLUS_APP_SECRET: "gps",
      COINGECKO_DEMO_KEY: "cg",
      NEYNAR_API_KEY: "ny",
      HELIUS_API_KEY: "he",
      INFURA_API_KEY: "in",
      DISCORD_WEBHOOK_URL: "https://discord.example/hook",
      TAVILY_API_KEY: "tavily",
    }
    const scrubbed = scrubChildEnv(polluted)
    for (const key of SCRUBBED_CHILD_ENV_KEYS) {
      expect(scrubbed[key]).toBeUndefined()
    }
    expect(scrubbed["PATH"]).toBe("/usr/bin")
    expect(scrubbed["HOME"]).toBe("/Users/test")
  })
})

import { describe, expect, it } from "vitest"
import { buildCursorCliArgs, assertPathOnlyPrompt, resolveCursorCliBin } from "../../src/orchestrator/session.js"

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

  it("resolves a binary name", () => {
    expect(resolveCursorCliBin()).toMatch(/agent/u)
  })

  it("rejects secret-bearing prompts", () => {
    expect(() => assertPathOnlyPrompt("leak CURSOR_API_KEY now")).toThrow(/secrets/u)
  })
})

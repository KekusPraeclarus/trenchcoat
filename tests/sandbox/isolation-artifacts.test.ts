import { describe, expect, it } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

describe("sandbox artifacts", () => {
  it("ships deny-all network sandbox config", () => {
    const path = join(process.cwd(), "agent/.cursor/sandbox.json")
    expect(existsSync(path)).toBe(true)
    const cfg = JSON.parse(readFileSync(path, "utf8")) as {
      networkPolicy: { default: string }
    }
    expect(cfg.networkPolicy.default).toBe("deny")
  })

  it("container compose mounts only agent and disables network", () => {
    const compose = readFileSync(
      join(process.cwd(), "containers/agent-runner/docker-compose.yml"),
      "utf8",
    )
    expect(compose).toMatch(/network_mode:\s*none/u)
    expect(compose).toMatch(/\.\.\/\.\.\/agent:\/workspace\/agent/u)
    expect(compose).not.toMatch(/\.env/u)
    expect(compose).not.toMatch(/\/Users\//u)
  })
})

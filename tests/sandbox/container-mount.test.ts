import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"

// Opt-in only: unset env keeps this suite silent so CI stays offline-clean.
const live = process.env["TRENCHCOAT_LIVE_ISOLATION"] === "1"

// Needs the compose v2 plugin, not just the docker client, so `docker compose
// config` below never fails on hosts lacking the plugin.
function dockerComposeAvailable(): boolean {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const composePath = join(process.cwd(), "containers/agent-runner/docker-compose.yml")
const dockerfilePath = join(process.cwd(), "containers/agent-runner/Dockerfile")

describe.runIf(live)("container mount isolation (live)", () => {
  const hasCompose = dockerComposeAvailable()

  // Artifact assertions run without a daemon: they re-encode the invariants that
  // isolation-artifacts.test.ts guards, so a live run still fails loudly on drift.
  it("compose still encodes deny-all network and agent-only mount", () => {
    const compose = readFileSync(composePath, "utf8")
    expect(compose).toMatch(/network_mode:\s*none/u)
    expect(compose).toMatch(/\.\.\/\.\.\/agent:\/workspace\/agent/u)
    expect(compose).not.toMatch(/\.env/u)
    expect(compose).not.toMatch(/\/Users\//u)
  })

  it("Dockerfile ships no secrets and mounts agent workspace", () => {
    const dockerfile = readFileSync(dockerfilePath, "utf8")
    expect(dockerfile).toMatch(/WORKDIR \/workspace\/agent/u)
    expect(dockerfile).not.toMatch(/API_KEY|SECRET|TOKEN/u)
  })

  it.skipIf(!hasCompose)("docker compose config parses with network_mode none", () => {
    const rendered = execFileSync(
      "docker",
      ["compose", "-f", composePath, "config"],
      { encoding: "utf8" },
    )
    expect(rendered).toMatch(/network_mode:\s*none/u)
    expect(rendered).toMatch(/\/workspace\/agent/u)
  })

  it.runIf(!hasCompose)("skips daemon parse when docker compose unavailable", () => {
    // Blocker recorded as a passing no-op so absence of compose never fails CI.
    expect(hasCompose).toBe(false)
  })
})

describe.runIf(!live)("container mount isolation placeholder", () => {
  it("skips when TRENCHCOAT_LIVE_ISOLATION is not set", () => {
    expect(live).toBe(false)
  })
})

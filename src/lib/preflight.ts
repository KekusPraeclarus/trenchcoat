import { execFileSync } from "node:child_process"
import type { PreflightResult } from "./preflight-types.js"
import { resolveCursorCliBin } from "../orchestrator/session.js"
import { loadConfig } from "./config.js"
import { fomoSessionExists } from "../collectors/social/fomo-auth.js"

export type { PreflightResult }

export function runPreflight(opts: Readonly<{ live?: boolean }> = {}): PreflightResult {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = []
  const parts = process.versions.node.split(".")
  const nodeMajor = Number(parts[0])
  const nodeMinor = Number(parts[1])
  const nodeOk = nodeMajor > 22 || (nodeMajor === 22 && (nodeMinor ?? 0) >= 13)
  checks.push({ name: "node", ok: nodeOk, detail: `node ${process.versions.node}` })

  const bin = resolveCursorCliBin()
  try {
    const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim()
    checks.push({ name: "cursor-cli", ok: true, detail: `${bin} ${version}` })
  } catch {
    checks.push({
      name: "cursor-cli",
      ok: false,
      detail: "missing — install via https://cursor.com/docs/cli/installation",
    })
  }

  if (opts.live) {
    try {
      const status = execFileSync(bin, ["status"], { encoding: "utf8" })
      const loggedIn = /logged in/iu.test(status)
      checks.push({
        name: "cursor-cli-login",
        ok: loggedIn,
        detail: loggedIn ? "logged in" : "run `agent login`",
      })
    } catch {
      checks.push({ name: "cursor-cli-login", ok: false, detail: "status check failed" })
    }
  }

  for (const key of [
    "TRENCHCOAT_ROUTER_URL",
    "TRENCHCOAT_ROUTER_TOKEN",
    "TRENCHCOAT_ROUTER_HMAC_KEY",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_OPERATOR_ID",
  ]) {
    const present = Boolean(process.env[key]?.trim())
    checks.push({
      name: `env:${key}`,
      ok: !opts.live || present,
      detail: present ? "set" : "missing",
    })
  }

  if (opts.live) {
    for (const key of [
      "HELIUS_API_KEY",
      "INFURA_API_KEY",
      "NEYNAR_API_KEY",
      "GOPLUS_APP_KEY",
      "COINGECKO_DEMO_KEY",
    ]) {
      const present = Boolean(process.env[key]?.trim())
      checks.push({ name: `env:${key}`, ok: present, detail: present ? "set" : "missing" })
    }
  }

  try {
    const cfg = loadConfig()
    if (cfg.fomo.enabled) {
      const present = fomoSessionExists()
      checks.push({
        name: "fomo-session",
        ok: present,
        detail: present ? "present" : "missing (required when fomo.enabled)",
      })
    }
  } catch {
    // config may be absent during early install
  }

  return { ok: checks.every((c) => c.ok), checks }
}

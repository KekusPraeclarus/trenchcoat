import type { PreflightResult } from "./preflight-types.js"

export type { PreflightResult }

export function runPreflight(opts: Readonly<{ live?: boolean }> = {}): PreflightResult {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = []
  const parts = process.versions.node.split(".")
  const nodeMajor = Number(parts[0])
  const nodeMinor = Number(parts[1])
  const nodeOk = nodeMajor > 22 || (nodeMajor === 22 && (nodeMinor ?? 0) >= 13)
  checks.push({ name: "node", ok: nodeOk, detail: `node ${process.versions.node}` })

  for (const key of [
    "CURSOR_API_KEY",
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

  return { ok: checks.every((c) => c.ok), checks }
}

import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { log } from "../lib/log.js"

const LABEL = "com.trenchcoat.job.discord-chain-integration"

function runtimeCli(): string | undefined {
  const candidates = [
    join(homedir(), ".trenchcoat", "runtime", "dist", "cli.js"),
    process.argv[1],
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return undefined
}

function spawnDetachedCli(): void {
  const cli = runtimeCli()
  if (!cli) {
    log.warn("chain-integration kick: no cli binary")
    return
  }
  const child = spawn(process.execPath, [cli, "discord", "chains", "run"], {
    stdio: "ignore",
    detached: true,
    env: process.env,
  })
  child.unref()
}

/** Prefer launchd one-shot; fall back to detached local CLI process */
export function kickChainIntegrationWorker(): void {
  const uid = process.getuid?.() ?? 501
  const domain = `gui/${uid}`
  const listed = spawnSync("launchctl", ["print", `${domain}/${LABEL}`], {
    encoding: "utf8",
  })
  if ((listed.status ?? 1) === 0) {
    const kick = spawn("launchctl", ["kickstart", `${domain}/${LABEL}`], {
      stdio: "ignore",
      detached: true,
    })
    kick.unref()
    return
  }
  spawnDetachedCli()
}

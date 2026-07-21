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

const SYSTEMD_UNIT = "trenchcoat-job-discord-chain-integration.service"

/** Prefer launchd / user-systemd one-shot; fall back to detached local CLI */
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

  const sys = spawnSync(
    "systemctl",
    ["--user", "show", SYSTEMD_UNIT, "--property=LoadState", "--value"],
    { encoding: "utf8" },
  )
  if ((sys.status ?? 1) === 0 && String(sys.stdout).trim() === "loaded") {
    const kick = spawn("systemctl", ["--user", "start", SYSTEMD_UNIT], {
      stdio: "ignore",
      detached: true,
      env: {
        ...process.env,
        XDG_RUNTIME_DIR:
          process.env.XDG_RUNTIME_DIR ?? `/run/user/${String(uid)}`,
      },
    })
    kick.unref()
    return
  }

  spawnDetachedCli()
}

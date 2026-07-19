import { spawn, type ChildProcess } from "node:child_process"
import { loadConfig } from "../lib/config.js"
import { log } from "../lib/log.js"

export type ListenerChild = Readonly<{
  name: string
  proc: ChildProcess
}>

function discordListenerEnabled(): boolean {
  try {
    const cfg = loadConfig()
    if (!cfg.chat.discord.enabled) return false
    if (!cfg.chat.discord.guild_id || cfg.chat.discord.channel_ids.length === 0) {
      log.warn("discord listener skipped: guild_id or channel_ids missing")
      return false
    }
    if (!process.env["DISCORD_RESEARCH_BOT_TOKEN"]?.trim()) {
      log.warn("discord listener skipped: DISCORD_RESEARCH_BOT_TOKEN missing")
      return false
    }
    return true
  } catch (error) {
    log.warn("discord listener skipped: config load failed", {
      detail: error instanceof Error ? error.message : "unknown",
    })
    return false
  }
}

function spawnListenerChild(name: string, subcommand: string): ChildProcess {
  const proc = spawn(process.execPath, [process.argv[1]!, "listen", subcommand], {
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  })
  proc.on("error", (error) => {
    log.error(`${name} listener spawn failed`, {
      detail: error instanceof Error ? error.message : "unknown",
    })
  })
  return proc
}

export async function superviseAgentListeners(args: Readonly<{
  runTelegram: () => Promise<void>
}>): Promise<void> {
  const children: ListenerChild[] = []
  let shuttingDown = false
  let discordRestartTimer: ReturnType<typeof setTimeout> | undefined

  const stopChild = (child: ChildProcess): Promise<void> => new Promise((resolve) => {
    if (child.killed || child.exitCode !== null) {
      resolve()
      return
    }
    child.once("exit", () => resolve())
    child.kill("SIGTERM")
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL")
    }, 5_000).unref()
  })

  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    if (discordRestartTimer) clearTimeout(discordRestartTimer)
    log.info(`agent listeners shutting down (${signal})`)
    await Promise.all(children.map((c) => stopChild(c.proc)))
    process.exit(0)
  }

  process.on("SIGTERM", () => { void shutdown("SIGTERM") })
  process.on("SIGINT", () => { void shutdown("SIGINT") })

  const startDiscord = () => {
    if (shuttingDown || !discordListenerEnabled()) return
    const proc = spawnListenerChild("discord", "discord")
    const entry: ListenerChild = { name: "discord", proc }
    children.push(entry)
    log.info("discord listener child started", { pid: proc.pid })

    proc.on("exit", (code, signal) => {
      const idx = children.indexOf(entry)
      if (idx >= 0) children.splice(idx, 1)
      if (shuttingDown) return
      log.warn("discord listener child exited", { code, signal })
      discordRestartTimer = setTimeout(() => {
        discordRestartTimer = undefined
        startDiscord()
      }, 5_000)
      discordRestartTimer.unref()
    })
  }

  if (discordListenerEnabled()) {
    startDiscord()
  }

  await args.runTelegram()
}

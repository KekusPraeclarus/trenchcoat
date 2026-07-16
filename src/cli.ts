import { mkdirSync, writeFileSync, existsSync, cpSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { ConfigSchema, assertSocialPermissions } from "./lib/config.js"
import { migrateConfigToV2 } from "./migrations/config.js"
import { runJob } from "./orchestrator/run.js"
import { getJob, JOBS } from "./orchestrator/jobs.js"
import { runPreflight } from "./lib/preflight.js"
import { log } from "./lib/log.js"
import { createRouterServer } from "./router/server.js"
import { handleChatUpdate } from "./chat/handler.js"

function usage(): never {
  console.log(`trenchcoat (tc)

Commands:
  init [--seed path]
  run <job> [--skip-agent] [--dry-collect]
  status [--heal]
  preflight [--live]
  router serve
  listen telegram
  research <subject>
  jobs
`)
  process.exit(1)
}

async function cmdInit(seedPath?: string): Promise<void> {
  const destDir = join(homedir(), ".trenchcoat")
  mkdirSync(destDir, { recursive: true, mode: 0o700 })
  const seed = seedPath ?? join(process.cwd(), "config/seed.example.json")
  const raw = JSON.parse(readFileSync(seed, "utf8")) as unknown
  const cfg = ConfigSchema.parse(migrateConfigToV2(raw))
  assertSocialPermissions(cfg)
  writeFileSync(join(destDir, "config.json"), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 })
  const agentSrc = join(process.cwd(), "agent")
  const agentDest = join(destDir, "agent")
  if (!existsSync(agentDest) && existsSync(agentSrc)) {
    cpSync(agentSrc, agentDest, { recursive: true })
  }
  mkdirSync(join(destDir, "archive"), { recursive: true, mode: 0o700 })
  console.log(`initialized ${destDir}`)
}

async function cmdRun(jobName: string, args: string[]): Promise<void> {
  getJob(jobName)
  const home = join(homedir(), ".trenchcoat")
  const agentRoot = existsSync(join(home, "agent"))
    ? join(home, "agent")
    : join(process.cwd(), "agent")
  const archiveRoot = existsSync(join(home, "archive"))
    ? join(home, "archive")
    : join(process.cwd(), ".trenchcoat-local", "archive")
  const result = await runJob({
    job: jobName as never,
    paths: { agentRoot, archiveRoot },
    skipAgent: args.includes("--skip-agent"),
    dryCollect: args.includes("--dry-collect"),
  })
  process.exit(result.exitCode)
}

async function cmdRouterServe(): Promise<void> {
  const hmacKey = process.env["TRENCHCOAT_ROUTER_HMAC_KEY"]
  if (!hmacKey) throw new Error("TRENCHCOAT_ROUTER_HMAC_KEY required")
  const home = join(homedir(), ".trenchcoat")
  const server = createRouterServer({
    dbPath: join(home, "router.sqlite3"),
    hmacKey,
    host: process.env["TRENCHCOAT_ROUTER_HOST"] ?? "127.0.0.1",
    port: Number(process.env["TRENCHCOAT_ROUTER_PORT"] ?? 8787),
    ...(process.env["TELEGRAM_ROUTER_BOT_TOKEN"]
      ? { telegramBotToken: process.env["TELEGRAM_ROUTER_BOT_TOKEN"] }
      : {}),
    ...(process.env["TELEGRAM_ROUTER_CHAT_ID"]
      ? { telegramChatId: process.env["TELEGRAM_ROUTER_CHAT_ID"] }
      : {}),
    ...(process.env["DISCORD_WEBHOOK_URL"]
      ? { discordWebhookUrl: process.env["DISCORD_WEBHOOK_URL"] }
      : {}),
  })
  const addr = await server.start()
  log.info("router listening", { addr })
  const stop = async () => {
    await server.stop()
    process.exit(0)
  }
  process.on("SIGINT", () => { void stop() })
  process.on("SIGTERM", () => { void stop() })
}

async function cmdListenTelegram(): Promise<void> {
  const token = process.env["TELEGRAM_BOT_TOKEN"]
  const operatorId = process.env["TELEGRAM_OPERATOR_ID"]
  if (!token || !operatorId) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_OPERATOR_ID required")
  // Long-poll stub: production uses grammy; keep allowlist gate first.
  console.log("telegram listener starting (allowlist enforced)")
  const offsetPath = join(homedir(), ".trenchcoat", "telegram-offset.json")
  let offset = 0
  if (existsSync(offsetPath)) {
    offset = Number(JSON.parse(readFileSync(offsetPath, "utf8")).offset ?? 0)
  }
  for (;;) {
    const url = `https://api.telegram.org/bot${token}/getUpdates?timeout=30&offset=${offset}`
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) })
    const body = await res.json() as {
      ok: boolean
      result: Array<{ update_id: number; message?: { from?: { id: number }; text?: string; chat: { id: number } } }>
    }
    if (!body.ok) {
      await new Promise((r) => setTimeout(r, 2000))
      continue
    }
    for (const update of body.result) {
      offset = update.update_id + 1
      const msg = update.message
      if (!msg?.from || !msg.text) continue
      await handleChatUpdate({
        chatId: String(msg.chat.id),
        userId: String(msg.from.id),
        text: msg.text,
        allowlist: [operatorId],
        send: async (chatId, text) => {
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text }),
            redirect: "error",
          })
        },
      })
    }
    writeFileSync(offsetPath, `${JSON.stringify({ offset })}\n`, { mode: 0o600 })
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (!cmd) usage()
  switch (cmd) {
    case "init":
      await cmdInit(rest.includes("--seed") ? rest[rest.indexOf("--seed") + 1] : undefined)
      break
    case "run":
      if (!rest[0]) usage()
      await cmdRun(rest[0]!, rest.slice(1))
      break
    case "jobs":
      for (const job of JOBS) console.log(`${job.name}\t${job.description}`)
      break
    case "status": {
      const pf = runPreflight({ live: false })
      for (const c of pf.checks) console.log(`${c.ok ? "OK" : "FAIL"} ${c.name}: ${c.detail}`)
      if (rest.includes("--heal")) {
        console.log("heal: re-scaffold agent if missing")
        spawn("pnpm", ["prepare:agent"], { stdio: "inherit" })
      }
      process.exit(pf.ok ? 0 : 1)
      break
    }
    case "preflight":
      {
        const pf = runPreflight({ live: rest.includes("--live") })
        for (const c of pf.checks) console.log(`${c.ok ? "OK" : "FAIL"} ${c.name}: ${c.detail}`)
        process.exit(pf.ok ? 0 : 1)
      }
      break
    case "router":
      if (rest[0] !== "serve") usage()
      await cmdRouterServe()
      break
    case "listen":
      if (rest[0] !== "telegram") usage()
      await cmdListenTelegram()
      break
    case "auth":
      if (rest[0] !== "twitter") usage()
      {
        const { authTwitterInteractive } = await import("./collectors/social/twitter-auth.js")
        await authTwitterInteractive()
      }
      break
    case "research":
      if (!rest[0]) usage()
      await cmdRun("research", ["--skip-agent", "--dry-collect"])
      break
    default:
      usage()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

import { mkdirSync, writeFileSync, existsSync, cpSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { loadDotEnv } from "./lib/dotenv.js"
import { ConfigSchema } from "./lib/config.js"
import { migrateConfigToV4 } from "./migrations/config.js"
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
  probe twitter [--headed]
  source-list review [--dry-run] [--no-sync]
  source-list sync
  x-engagement dry-run <run-id>
  x-engagement status
  router serve
  listen telegram
  research <subject>
  auth twitter [--create-managed-list] [--headed]
  jobs
`)
  process.exit(1)
}

function resolveHomes(): { agentRoot: string, archiveRoot: string } {
  const home = join(homedir(), ".trenchcoat")
  const agentRoot = existsSync(join(home, "agent"))
    ? join(home, "agent")
    : join(process.cwd(), "agent")
  const archiveRoot = existsSync(join(home, "archive"))
    ? join(home, "archive")
    : join(process.cwd(), ".trenchcoat-local", "archive")
  return { agentRoot, archiveRoot }
}

async function cmdInit(seedPath?: string): Promise<void> {
  const destDir = join(homedir(), ".trenchcoat")
  mkdirSync(destDir, { recursive: true, mode: 0o700 })
  const seed = seedPath ?? join(process.cwd(), "config/seed.example.json")
  const raw = JSON.parse(readFileSync(seed, "utf8")) as unknown
  const cfg = ConfigSchema.parse(migrateConfigToV4(raw))
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
  const { agentRoot, archiveRoot } = resolveHomes()
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
  loadDotEnv()
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
    case "probe":
      if (rest[0] !== "twitter") usage()
      {
        const { loadConfig } = await import("./lib/config.js")
        const { scrapeConfiguredTwitter, summarizeScrape } = await import("./collectors/twitter/scrape.js")
        const { probeSourceListSummary } = await import("./orchestrator/source-list.js")
        const { probeEngagementSummary } = await import("./orchestrator/x-engagement.js")
        const cfg = loadConfig()
        const headed = rest.includes("--headed")
        const { agentRoot } = resolveHomes()
        const bundles = await scrapeConfiguredTwitter(cfg, { headless: !headed })
        console.log(JSON.stringify({
          scrape: summarizeScrape(bundles),
          lifecycle: probeSourceListSummary(agentRoot, cfg),
          engagement: probeEngagementSummary(agentRoot, cfg),
        }, null, 2))
        if (bundles.some((b) => b.challenged)) {
          console.error("Challenge/login detected — re-run: pnpm dev:cli auth twitter")
          process.exit(2)
        }
      }
      break
    case "source-list":
      {
        const sub = rest[0]
        const { agentRoot, archiveRoot } = resolveHomes()
        if (sub === "review") {
          const { runSourceListReview } = await import("./orchestrator/source-list.js")
          const report = await runSourceListReview({
            agentRoot,
            archiveRoot,
            dryRun: rest.includes("--dry-run"),
            sync: !rest.includes("--no-sync") && !rest.includes("--dry-run"),
          })
          console.log(JSON.stringify(report, null, 2))
        } else if (sub === "sync") {
          const { syncPendingSourceList } = await import("./orchestrator/source-list.js")
          const receipt = await syncPendingSourceList({ agentRoot, archiveRoot })
          console.log(JSON.stringify(receipt, null, 2))
          if (receipt.ambiguous || !receipt.verified) process.exit(2)
        } else {
          usage()
        }
      }
      break
    case "x-engagement":
      {
        const sub = rest[0]
        const { agentRoot, archiveRoot } = resolveHomes()
        if (sub === "status") {
          const { loadConfig } = await import("./lib/config.js")
          const { probeEngagementSummary } = await import("./orchestrator/x-engagement.js")
          console.log(JSON.stringify(probeEngagementSummary(agentRoot, loadConfig()), null, 2))
        } else if (sub === "dry-run") {
          const runId = rest[1]
          if (!runId) usage()
          const { processListScanEngagement } = await import("./orchestrator/x-engagement.js")
          const report = await processListScanEngagement({
            agentRoot,
            archiveRoot,
            runId: runId!,
            dryRun: true,
            execute: false,
          })
          console.log(JSON.stringify(report, null, 2))
        } else {
          usage()
        }
      }
      break
    case "auth":
      if (rest[0] !== "twitter") usage()
      {
        if (rest.includes("--create-managed-list")) {
          const { createAndPersistManagedList } = await import("./orchestrator/source-list.js")
          const identity = await createAndPersistManagedList()
          console.log(`Created managed list ${identity.listId}`)
          console.log(identity.listUrl)
        } else {
          const { authTwitterInteractive } = await import("./collectors/social/twitter-auth.js")
          await authTwitterInteractive()
        }
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

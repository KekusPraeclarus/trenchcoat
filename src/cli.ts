import { mkdirSync, writeFileSync, existsSync, cpSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { loadDotEnv } from "./lib/dotenv.js"
import { ConfigSchema } from "./lib/config.js"
import { migrateConfigToV7 } from "./migrations/config.js"
import { runJob } from "./orchestrator/run.js"
import { getJob, JOBS } from "./orchestrator/jobs.js"
import { runPreflight } from "./lib/preflight.js"
import { log } from "./lib/log.js"
import { createRouterServer } from "./router/server.js"
import { allocateDraftId, createDraftStream } from "./chat/draft.js"
import { handleChatUpdate } from "./chat/handler.js"
import { createChatTurnRunner, fileChatSessionStore } from "./chat/session.js"
import {
  telegramSendChatAction,
  telegramSendMessage,
  telegramSendMessageDraft,
  telegramSendOperatorMessageChunks,
} from "./lib/telegram-bot.js"

function usage(): never {
  console.log(`trenchcoat (tc)

Commands:
  init [--seed path] [--operator-seed path]
  run <job> [--skip-agent] [--dry-collect]
  precheck <job>
  config validate
  config migrate --write
  outcomes settle
  delivery retry
  undock <id>
  confirm <id>
  status [--heal] [--json]
  watchlist remove <chain:token> --subject <symbol> --reason <text>
  preflight [--live]
  probe twitter [--headed]
  probe farcaster
  source-list review [--dry-run] [--no-sync]
  source-list sync
  fc-source review [--dry-run] [--no-sync]
  fc-source seed <path> [--dry-run]
  fc-source sync [--dry-run]
  wallets seed <path>
  x-engagement dry-run <run-id>
  x-engagement status
  fc-engagement dry-run <run-id>
  fc-engagement status
  harness run [--dry-run] [--skip-tests] [--skip-deploy]
  harness propose --epoch <id>
  harness prepare <hypothesis-id>
  harness evaluate <hypothesis-id> --dev-epoch <id> --holdout-epoch <id>
  harness activate <hypothesis-id> [--no-wait] [--timeout-ms <n>]
  harness drain [--wait] [--timeout-ms <n>]
  harness wait-idle [--timeout-ms <n>]
  harness canary start <hypothesis-id>
  harness canary stop --reason <text>
  harness status
  harness promote <hypothesis-id>
  harness rollback --reason <text>
  router serve
  listen [telegram|discord|channels]
  discord watchlist scan
  backup
  research <subject>
  auth twitter [--create-managed-list] [--headed]
  auth fomo [--headed]
  auth farcaster --create --fname <name>
  auth farcaster --fid <n> --username <name> --mnemonic-stdin
  auth telegram-channels
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

async function cmdInit(seedPath?: string, operatorSeedPath?: string): Promise<void> {
  const destDir = join(homedir(), ".trenchcoat")
  mkdirSync(destDir, { recursive: true, mode: 0o700 })
  const seed = seedPath ?? join(process.cwd(), "config/seed.example.json")
  const raw = JSON.parse(readFileSync(seed, "utf8")) as unknown
  const cfg = ConfigSchema.parse(migrateConfigToV7(raw))
  writeFileSync(join(destDir, "config.json"), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 })
  const agentSrc = join(process.cwd(), "agent")
  const agentDest = join(destDir, "agent")
  if (!existsSync(agentDest) && existsSync(agentSrc)) {
    cpSync(agentSrc, agentDest, { recursive: true })
  }
  mkdirSync(join(destDir, "archive"), { recursive: true, mode: 0o700 })
  if (existsSync(join(agentDest, "state")) || existsSync(join(process.cwd(), "agent", "state"))) {
    const { migrateGenericNarrativeResearchQueue } = await import("./migrations/research-queue.js")
    const repair = await migrateGenericNarrativeResearchQueue({
      agentRoot: existsSync(agentDest) ? agentDest : join(process.cwd(), "agent"),
      archiveRoot: join(destDir, "archive"),
    })
    if (repair.repairedCount > 0) {
      console.log(`repaired ${repair.repairedCount} generic narrative queue entries`)
    }
  }
  if (operatorSeedPath) {
    const { applyOperatorWalletSeed } = await import("./orchestrator/wallet-seed.js")
    const report = await applyOperatorWalletSeed({
      agentRoot: existsSync(agentDest) ? agentDest : join(process.cwd(), "agent"),
      archiveRoot: join(destDir, "archive"),
      seedPath: operatorSeedPath,
    })
    console.log(`seeded ${report.added} wallets → ${report.receiptPath}`)
    if (report.skippedWatchlist > 0 || report.skippedSources > 0) {
      console.log("note: watchlist/sources in operator seed are not applied yet (wallets only)")
    }
  }
  console.log(`initialized ${destDir}`)
}

async function cmdWalletsSeed(seedPath: string): Promise<void> {
  const { agentRoot, archiveRoot } = resolveHomes()
  const { applyOperatorWalletSeed } = await import("./orchestrator/wallet-seed.js")
  const report = await applyOperatorWalletSeed({ agentRoot, archiveRoot, seedPath })
  console.log(JSON.stringify(report, null, 2))
  if (report.skippedWatchlist > 0 || report.skippedSources > 0) {
    console.error("note: watchlist/sources in operator seed are not applied yet (wallets only)")
  }
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

async function cmdPrecheck(jobName: string): Promise<void> {
  getJob(jobName)
  const { agentRoot, archiveRoot } = resolveHomes()
  const { precheckJob } = await import("./orchestrator/preconditions.js")
  const result = await precheckJob({
    job: jobName as never,
    agentRoot,
    archiveRoot,
  })
  console.log(JSON.stringify(result))
  // Exit 10 = skip (launchd wrappers treat as successful noop)
  process.exit(result.skip ? 10 : 0)
}

async function cmdExoneration(id: string, target: "undock" | "confirm"): Promise<void> {
  const { agentRoot, archiveRoot } = resolveHomes()
  const { ensureArchive } = await import("./lib/archive.js")
  const { StateStore } = await import("./lib/state.js")
  const { SourceWriter } = await import("./orchestrator/sources-write.js")
  const { undock, confirm } = await import("./orchestrator/exoneration.js")
  const { systemClock } = await import("./lib/clock.js")
  const { WorkspaceLock, agentLockPath } = await import("./lib/lock.js")
  const lock = new WorkspaceLock(agentLockPath(agentRoot))
  if (!lock.tryAcquire()) {
    throw new Error("workspace lock held — another writer owns agent state")
  }
  try {
    const layout = await ensureArchive(archiveRoot)
    const writer = new SourceWriter(new StateStore(join(agentRoot, "state")))
    const resolve = target === "undock" ? undock : confirm
    const proposal = await resolve({
      layout,
      writer,
      id,
      by: "operator-cli",
      nowIso: systemClock.nowIso(),
    })
    console.log(JSON.stringify(proposal, null, 2))
  } finally {
    lock.release()
  }
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

async function cmdListenChannels(): Promise<void> {
  const { agentRoot } = resolveHomes()
  const home = join(homedir(), ".trenchcoat")
  const { loadConfig } = await import("./lib/config.js")
  const { runTelegramChannelsListener } = await import("./collectors/telegram/channels.js")
  const cfg = loadConfig()
  const channels = cfg.telegram_channels.map((c) => ({
    channel: c.channel,
    mode: c.mode,
  }))
  const ac = new AbortController()
  const stop = (): void => {
    ac.abort()
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  try {
    await runTelegramChannelsListener({
      agentRoot,
      channels,
      home,
      signal: ac.signal,
    })
  } catch (error) {
    if (ac.signal.aborted) return
    throw error
  }
}

async function cmdAuthTelegramChannels(): Promise<void> {
  const { authTelegramChannelsSession, telegramSessionPath } = await import(
    "./collectors/telegram/channels.js"
  )
  try {
    const result = await authTelegramChannelsSession({})
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    console.error(`expected session path: ${telegramSessionPath()}`)
    process.exit(1)
  }
}

async function cmdListenAll(): Promise<void> {
  const { superviseAgentListeners } = await import("./listen/supervisor.js")
  await superviseAgentListeners({ runTelegram: cmdListenTelegram })
}

async function cmdListenDiscord(): Promise<void> {
  const token = process.env["DISCORD_RESEARCH_BOT_TOKEN"]
  if (!token) throw new Error("DISCORD_RESEARCH_BOT_TOKEN required")

  const { loadConfig } = await import("./lib/config.js")
  const cfg = loadConfig()
  if (!cfg.chat.discord.enabled) {
    throw new Error("chat.discord.enabled is false in config")
  }

  const { runDiscordListener, resolveDiscordRepoRoot } = await import("./discord/listener.js")
  await runDiscordListener({ token, repoRoot: resolveDiscordRepoRoot() })
}

async function cmdDiscordWatchlistScan(): Promise<void> {
  const token = process.env["DISCORD_RESEARCH_BOT_TOKEN"]
  if (!token) throw new Error("DISCORD_RESEARCH_BOT_TOKEN required")
  const { runDiscordWatchlistScan } = await import("./discord/monitor.js")
  await runDiscordWatchlistScan({ token })
}

async function cmdListenTelegram(): Promise<void> {
  const token = process.env["TELEGRAM_BOT_TOKEN"]
  const operatorId = process.env["TELEGRAM_OPERATOR_ID"]
  if (!token || !operatorId) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_OPERATOR_ID required")

  const home = join(homedir(), ".trenchcoat")
  const { agentRoot, archiveRoot } = resolveHomes()
  let idleTimeoutMinutes = 30
  let researchConfirmTtlMinutes = 15
  const configPath = join(home, "config.json")
  if (existsSync(configPath)) {
    const cfg = ConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")))
    idleTimeoutMinutes = cfg.chat.idle_timeout_minutes
    researchConfirmTtlMinutes = cfg.chat.research_confirm_ttl_minutes
  }

  const runTurn = createChatTurnRunner({
    agentRoot,
    telegramUserId: operatorId,
    idleTimeoutMinutes,
    store: fileChatSessionStore(join(home, "chat-session.json")),
  })

  const { filePendingResearchStore } = await import("./chat/pending-research.js")
  const {
    processNextConfirmedResearch,
  } = await import("./orchestrator/research.js")
  const researchStore = filePendingResearchStore(join(home, "pending-research.json"))

  // Operator exoneration commands, bound to the host SourceWriter + archive (INV-S13).
  // Only the allowlisted operator reaches handleChatUpdate, so these are host-only writes.
  const { ensureArchive } = await import("./lib/archive.js")
  const { StateStore } = await import("./lib/state.js")
  const { SourceWriter } = await import("./orchestrator/sources-write.js")
  const { undock, confirm } = await import("./orchestrator/exoneration.js")
  const { systemClock } = await import("./lib/clock.js")
  const { WorkspaceLock, agentLockPath } = await import("./lib/lock.js")
  const exonerationLayout = await ensureArchive(archiveRoot)
  const exonerationWriter = new SourceWriter(new StateStore(join(agentRoot, "state")))
  const withExonerationLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const lock = new WorkspaceLock(agentLockPath(agentRoot))
    if (!lock.tryAcquire()) {
      throw new Error("workspace lock held — retry undock/confirm shortly")
    }
    try {
      return await fn()
    } finally {
      lock.release()
    }
  }
  const exonerationHooks = {
    undock: async (id: string): Promise<string> => {
      const p = await withExonerationLock(() => undock({
        layout: exonerationLayout,
        writer: exonerationWriter,
        id,
        by: "operator-telegram",
        nowIso: systemClock.nowIso(),
      }))
      return `undocked ${p.id} (${p.sourceId})`
    },
    confirm: async (id: string): Promise<string> => {
      const p = await withExonerationLock(() => confirm({
        layout: exonerationLayout,
        writer: exonerationWriter,
        id,
        by: "operator-telegram",
        nowIso: systemClock.nowIso(),
      }))
      return `confirmed dock ${p.id} (${p.sourceId})`
    },
  }

  let researchPumpRunning = false
  const pumpResearch = async (): Promise<void> => {
    if (researchPumpRunning) return
    researchPumpRunning = true
    try {
      for (;;) {
        const result = await processNextConfirmedResearch({
          paths: { agentRoot, archiveRoot },
          store: researchStore,
          choiceTtlMinutes: researchConfirmTtlMinutes,
          notify: async (text) => {
            await telegramSendOperatorMessageChunks(fetch, token, operatorId, text)
          },
          summarize: async (reportPath, subject) => {
            try {
              return await runTurn(
                [
                  `Summarize the completed research report at ${reportPath} for subject ${subject}.`,
                  "Write operator-facing Telegram markdown: **bold** section headers, short paragraphs, hyphen bullets.",
                  "Do not cite local workspace paths, report filenames, inbox paths, Source: lines, or decision-proposals.json.",
                  "External URLs and @handles are fine.",
                ].join(" "),
              )
            } catch {
              return undefined
            }
          },
        })
        if (result !== "processed") break
      }
    } catch (error) {
      log.error("research pump failed", {
        detail: error instanceof Error ? error.message : "unknown",
      })
    } finally {
      researchPumpRunning = false
    }
  }

  // Resume any confirmed-but-unfinished requests from a prior listener life
  void pumpResearch()
  const researchTimer = setInterval(() => { void pumpResearch() }, 10_000)

  log.info("telegram chat listener starting", {
    agentRoot,
    idleTimeoutMinutes,
    streaming: true,
    researchConfirmTtlMinutes,
  })
  const offsetPath = join(home, "telegram-offset.json")
  let offset = 0
  if (existsSync(offsetPath)) {
    offset = Number(JSON.parse(readFileSync(offsetPath, "utf8")).offset ?? 0)
  }

  for (;;) {
    const url = `https://api.telegram.org/bot${token}/getUpdates?timeout=30&offset=${offset}`
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) })
    const body = await res.json() as {
      ok: boolean
      result: Array<{
        update_id: number
        message?: {
          from?: { id: number }
          text?: string
          chat: { id: number; type?: string }
        }
      }>
    }
    if (!body.ok) {
      await new Promise((r) => setTimeout(r, 2000))
      continue
    }
    for (const update of body.result) {
      offset = update.update_id + 1
      const msg = update.message
      if (!msg?.from || !msg.text) continue
      // Private DMs only — group messages never elicit a reply (INV-B3)
      if (msg.chat.type && msg.chat.type !== "private") continue

      const trimmed = msg.text.trim()
      const hostHandled = trimmed.startsWith("/status")
        || trimmed.startsWith("/start")
        || /^(undock|confirm)\s+\S+/iu.test(trimmed)
        || /^(confirm|yes|y|do\s+it|go\s+ahead|approved?|cancel|no|n|never\s*mind|abort|stop)\s*[!.]*$/iu.test(trimmed)
        || /^[1-5]\s*$/u.test(trimmed)
        || /\b(research|deep\s+research|look\s*into|deep[\s-]?dive|investigate|dig\s+into)\b/iu.test(trimmed)
        || /^\/research\b/iu.test(trimmed)
        || /^(solana|ethereum|base|bsc|robinhood):[A-Za-z0-9]{32,128}$/iu.test(trimmed)
      const needsAgent = !hostHandled
      if (needsAgent) {
        await telegramSendChatAction(fetch, token, operatorId).catch(() => undefined)
      }

      try {
        await handleChatUpdate({
          chatId: String(msg.chat.id),
          userId: String(msg.from.id),
          text: msg.text,
          allowlist: [operatorId],
          replyChatId: operatorId,
          runTurn,
          research: {
            store: researchStore,
            ttlMinutes: researchConfirmTtlMinutes,
            onConfirmed: () => { void pumpResearch() },
          },
          exoneration: exonerationHooks,
          ...(needsAgent
            ? {
              openDraft: () => createDraftStream({
                draftId: allocateDraftId(),
                transport: {
                  sendDraft: (draftId, text) =>
                    telegramSendMessageDraft(fetch, token, operatorId, draftId, text),
                },
              }),
            }
            : {}),
          agentRoot,
          statusHomes: { agentRoot, archiveRoot },
          send: (chatId, text) => telegramSendOperatorMessageChunks(fetch, token, chatId, text).then(() => undefined),
        })
      } catch (error) {
        // Always advance offset below — a single bad update must not crash-loop launchd
        log.error("chat update failed", {
          detail: error instanceof Error ? error.message : "unknown",
        })
        await telegramSendMessage(
          fetch,
          token,
          operatorId,
          "chat update failed — check listener logs",
        ).catch(() => undefined)
      }
    }
    writeFileSync(offsetPath, `${JSON.stringify({ offset })}\n`, { mode: 0o600 })
  }

  clearInterval(researchTimer)
}

async function cmdResearch(subject: string, args: string[]): Promise<void> {
  const { agentRoot, archiveRoot } = resolveHomes()
  const { runOperatorResearchNow } = await import("./orchestrator/research.js")
  const { extractResearchIntent } = await import("./chat/research-intent.js")
  const intent = extractResearchIntent(`research ${subject}`)
  const chained = subject.match(
    /^(solana|ethereum|base|bsc|robinhood):([A-Za-z0-9]{32,128})$/iu,
  )
  const result = await runOperatorResearchNow({
    paths: { agentRoot, archiveRoot },
    input: {
      subject: intent.subject ?? subject,
      provenance: ["operator:cli"],
      reason: "cli research",
      ...(chained?.[1]
        ? { chainHint: chained[1].toLowerCase() as "solana" | "ethereum" | "base" | "bsc" | "robinhood" }
        : intent.chainHint
          ? { chainHint: intent.chainHint }
          : {}),
      ...(chained?.[2]
        ? { tokenHint: chained[2] }
        : intent.tokenHint
          ? { tokenHint: intent.tokenHint }
          : {}),
    },
    skipAgent: args.includes("--skip-agent"),
    dryCollect: args.includes("--dry-collect"),
  })
  console.log(JSON.stringify(result, null, 2))
  if (result.status === "busy") process.exit(3)
  if (result.status === "failed" || result.status === "rejected") process.exit(2)
}

async function cmdAuthFarcaster(args: string[]): Promise<void> {
  const { loadEnvSecrets, loadConfig, saveConfig, defaultConfigPath } = await import("./lib/config.js")
  const {
    createFarcasterAccount,
    attachSignerToExistingAccount,
  } = await import("./collectors/farcaster/signer.js")
  const secrets = loadEnvSecrets()
  if (!secrets.neynarApiKey) throw new Error("NEYNAR_API_KEY is required")

  const create = args.includes("--create")
  const fidIdx = args.indexOf("--fid")
  const usernameIdx = args.indexOf("--username")
  const fnameIdx = args.indexOf("--fname")

  if (create) {
    const fname = fnameIdx >= 0 ? args[fnameIdx + 1] : undefined
    if (!fname) throw new Error("auth farcaster --create requires --fname <name>")
    if (!secrets.neynarWalletId) {
      throw new Error("NEYNAR_WALLET_ID is required for account creation")
    }
    if (!secrets.farcasterAppFid || !secrets.farcasterAppMnemonic) {
      throw new Error("FARCASTER_APP_FID and FARCASTER_APP_MNEMONIC are required for account creation")
    }
    const appFid = Number(secrets.farcasterAppFid)
    if (!Number.isInteger(appFid) || appFid < 1) {
      throw new Error("FARCASTER_APP_FID must be a positive integer")
    }
    const file = await createFarcasterAccount({
      apiKey: secrets.neynarApiKey,
      walletId: secrets.neynarWalletId,
      fname,
      appFid,
      appMnemonic: secrets.farcasterAppMnemonic,
    })
    const cfg = loadConfig()
    await saveConfig({
      ...cfg,
      farcaster: {
        ...cfg.farcaster,
        enabled: true,
        bot_fid: file.fid,
      },
    }, defaultConfigPath())
    console.log(JSON.stringify({
      fid: file.fid,
      username: file.username,
      signerUuid: file.signerUuid,
      custodyAddress: file.custodyAddress,
      path: "~/.trenchcoat/farcaster/signer.json",
    }, null, 2))
    return
  }

  if (fidIdx >= 0 && args.includes("--mnemonic-stdin")) {
    const fid = Number(args[fidIdx + 1])
    const username = usernameIdx >= 0 ? args[usernameIdx + 1] : undefined
    if (!Number.isInteger(fid) || fid < 1 || !username) {
      throw new Error("auth farcaster --fid <n> --username <name> --mnemonic-stdin")
    }
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
    const custodyMnemonic = Buffer.concat(chunks).toString("utf8").trim()
    if (!custodyMnemonic) throw new Error("custody mnemonic required on stdin")
    const file = await attachSignerToExistingAccount({
      apiKey: secrets.neynarApiKey,
      fid,
      username,
      custodyMnemonic,
    })
    const cfg = loadConfig()
    await saveConfig({
      ...cfg,
      farcaster: {
        ...cfg.farcaster,
        enabled: true,
        bot_fid: file.fid,
      },
    }, defaultConfigPath())
    console.log(JSON.stringify({
      fid: file.fid,
      username: file.username,
      signerUuid: file.signerUuid,
      custodyAddress: file.custodyAddress,
      path: "~/.trenchcoat/farcaster/signer.json",
    }, null, 2))
    return
  }

  usage()
}

async function main(): Promise<void> {
  loadDotEnv()
  const [cmd, ...rest] = process.argv.slice(2)
  if (!cmd) usage()
  switch (cmd) {
    case "init":
      await cmdInit(
        rest.includes("--seed") ? rest[rest.indexOf("--seed") + 1] : undefined,
        rest.includes("--operator-seed") ? rest[rest.indexOf("--operator-seed") + 1] : undefined,
      )
      break
    case "wallets":
      if (rest[0] !== "seed" || !rest[1]) usage()
      await cmdWalletsSeed(rest[1]!)
      break
    case "run":
      if (!rest[0]) usage()
      await cmdRun(rest[0]!, rest.slice(1))
      break
    case "precheck":
      if (!rest[0]) usage()
      await cmdPrecheck(rest[0]!)
      break
    case "config": {
      if (rest[0] === "validate") {
        const { validateConfigFile } = await import("./lib/config.js")
        const result = validateConfigFile()
        console.log(JSON.stringify(result))
        process.exit(0)
      }
      if (rest[0] === "migrate" && rest.includes("--write")) {
        const { migrateAndSaveConfig } = await import("./lib/config.js")
        const result = await migrateAndSaveConfig()
        console.log(JSON.stringify({ ok: true, ...result }))
        process.exit(0)
      }
      usage()
      break
    }
    case "watchlist": {
      if (rest[0] !== "remove" || !rest[1]) usage()
      const subjectIdx = rest.indexOf("--subject")
      const reasonIdx = rest.indexOf("--reason")
      if (subjectIdx < 0 || reasonIdx < 0 || !rest[subjectIdx + 1] || !rest[reasonIdx + 1]) {
        usage()
      }
      const { removeWatchlistEntry } = await import("./orchestrator/watchlist-remove.js")
      const { agentRoot, archiveRoot } = resolveHomes()
      const report = await removeWatchlistEntry({
        agentRoot,
        archiveRoot,
        identityKey: rest[1]!,
        subject: rest[subjectIdx + 1]!,
        reason: rest.slice(reasonIdx + 1).join(" "),
      })
      console.log(JSON.stringify(report, null, 2))
      break
    }
    case "outcomes":
      if (rest[0] !== "settle") usage()
      await cmdRun("outcomes-settle", rest.slice(1))
      break
    case "delivery":
      if (rest[0] !== "retry") usage()
      await cmdRun("delivery-retry", rest.slice(1))
      break
    case "undock":
      if (!rest[0]) usage()
      await cmdExoneration(rest[0]!, "undock")
      break
    case "confirm":
      if (!rest[0]) usage()
      await cmdExoneration(rest[0]!, "confirm")
      break
    case "jobs":
      for (const job of JOBS) console.log(`${job.name}\t${job.description}`)
      break
    case "status": {
      const wantJson = rest.includes("--json")
      const { archiveRoot, agentRoot } = resolveHomes()
      const pf = runPreflight({ live: false })
      let configOk = true
      let runtimeOk = true
      const configLines: string[] = []
      for (const c of pf.checks) {
        configLines.push(`${c.ok ? "OK" : "FAIL"} ${c.name}: ${c.detail}`)
      }
      try {
        const { loadConfig, defaultConfigPath } = await import("./lib/config.js")
        const { loadDeploymentManifest } = await import("./lib/deployment.js")
        const cfg = loadConfig()
        configLines.push(`OK config: schema ${cfg.schema} at ${defaultConfigPath()}`)
        const manifest = loadDeploymentManifest()
        if (manifest) {
          configLines.push(
            `OK runtime: v${manifest.packageVersion} schema=${manifest.configSchema} built=${manifest.builtAt}`
              + (manifest.sourceCommit ? ` commit=${manifest.sourceCommit.slice(0, 12)}` : "")
              + (manifest.sourceDirty ? " DIRTY" : "")
              + ` src=${manifest.sourceHash.slice(0, 19)}`,
          )
        } else {
          runtimeOk = false
          configLines.push("FAIL runtime: deployment.json missing — re-run ops/install-launchd.sh")
        }
      } catch (error) {
        configOk = false
        configLines.push(`FAIL config: ${error instanceof Error ? error.message : String(error)}`)
      }

      const {
        buildHealthSnapshot,
        formatHealthText,
        toHealthJsonPayload,
      } = await import("./orchestrator/health.js")
      const health = await buildHealthSnapshot({ agentRoot, archiveRoot })
      let discordStatus: Awaited<ReturnType<typeof import("./discord/status.js")["loadDiscordStatus"]>> | undefined
      try {
        const { loadConfig } = await import("./lib/config.js")
        const cfg = loadConfig()
        if (cfg.chat.discord.enabled) {
          const { loadDiscordStatus } = await import("./discord/status.js")
          discordStatus = loadDiscordStatus()
        }
      } catch {
        // discord status is best-effort
      }

      if (wantJson) {
        console.log(JSON.stringify({
          preflight: { ok: pf.ok && configOk && runtimeOk, checks: pf.checks },
          health: toHealthJsonPayload(health),
          ...(discordStatus ? { discord: discordStatus } : {}),
        }, null, 2))
      } else {
        for (const line of configLines) console.log(line)
        console.log("")
        console.log(formatHealthText(health))
        if (discordStatus) {
          console.log("")
          console.log("Discord research:")
          console.log(`  queue=${discordStatus.queueDepth} running=${discordStatus.running}`)
          console.log(`  watched tokens=${discordStatus.watchedTokens} subscribers=${discordStatus.subscribers}`)
          if (discordStatus.listenerHeartbeatAgeSec != null) {
            console.log(`  listener heartbeat age=${discordStatus.listenerHeartbeatAgeSec}s`)
          }
          if (discordStatus.monitorHeartbeatAgeSec != null) {
            console.log(`  monitor heartbeat age=${discordStatus.monitorHeartbeatAgeSec}s`)
          }
          if (discordStatus.lastListenerError) {
            console.log(`  listener error: ${discordStatus.lastListenerError}`)
          }
        }
      }

      if (rest.includes("--heal")) {
        const { listIncompleteRuns } = await import("./orchestrator/run.js")
        const incomplete = await listIncompleteRuns(archiveRoot)
        if (incomplete.length === 0) {
          console.log("heal: no incomplete runs")
        } else {
          for (const run of incomplete) {
            console.log(`heal: incomplete run ${run.runId}${run.quarantined ? " (quarantined — needs operator review)" : ""}`)
          }
        }
        const lockPath = join(agentRoot, ".lock")
        const ownerPath = `${lockPath}.owner`
        if (existsSync(ownerPath)) {
          const pid = Number(readFileSync(ownerPath, "utf8").trim())
          let alive = false
          if (Number.isInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 0)
              alive = true
            } catch {
              alive = false
            }
          }
          console.log(alive
            ? `heal: workspace lock held by pid ${pid}`
            : `heal: stale workspace lock (pid ${pid || "unknown"} gone)`)
        }
        console.log("heal: re-scaffold agent if missing")
        spawn("pnpm", ["prepare:agent"], { stdio: "inherit" })
      }
      // Health warnings stay non-fatal; config/auth/runtime integrity failures exit non-zero
      process.exit(pf.ok && configOk && runtimeOk ? 0 : 1)
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
      if (rest[0] === "telegram") {
        await cmdListenTelegram()
      } else if (rest[0] === "discord") {
        await cmdListenDiscord()
      } else if (rest[0] === "channels") {
        await cmdListenChannels()
      } else if (rest[0] === undefined) {
        await cmdListenAll()
      } else {
        usage()
      }
      break
    case "discord":
      if (rest[0] === "watchlist" && rest[1] === "scan") {
        await cmdDiscordWatchlistScan()
      } else {
        usage()
      }
      break
    case "backup": {
      const { agentRoot, archiveRoot } = resolveHomes()
      const { listArchiveBackupFiles, writeBackupManifest } = await import("./orchestrator/backup.js")
      const destDir = process.env["TRENCHCOAT_BACKUP_DIR"]
        ?? join(homedir(), ".trenchcoat", "backups")
      const files = listArchiveBackupFiles(archiveRoot)
      const result = await writeBackupManifest(archiveRoot, destDir, files)
      console.log(JSON.stringify({
        agentRoot,
        archiveRoot,
        destDir,
        fileCount: files.length,
        ...result,
      }, null, 2))
      break
    }
    case "probe":
      if (rest[0] === "twitter") {
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
      } else if (rest[0] === "farcaster") {
        const { loadConfig, loadEnvSecrets } = await import("./lib/config.js")
        const { scrapeConfiguredFarcaster, summarizeFarcasterScrape } = await import("./collectors/farcaster/scrape.js")
        const { probeFcSourceListSummary } = await import("./orchestrator/fc-source-list.js")
        const { probeFcEngagementSummary } = await import("./orchestrator/fc-engagement.js")
        const { probeFarcasterSigner, buildSignerGateReceipt } = await import("./collectors/farcaster/signer.js")
        const cfg = loadConfig()
        const secrets = loadEnvSecrets()
        if (!secrets.neynarApiKey) throw new Error("NEYNAR_API_KEY required")
        const { agentRoot } = resolveHomes()
        const nowIso = new Date().toISOString()
        const signerProbe = await probeFarcasterSigner({
          apiKey: secrets.neynarApiKey,
          nowIso,
        })
        const signerGate = buildSignerGateReceipt(signerProbe)
        const bundles = await scrapeConfiguredFarcaster(cfg, {
          apiKey: secrets.neynarApiKey,
          fetchedAt: nowIso,
        })
        console.log(JSON.stringify({
          scrape: summarizeFarcasterScrape(bundles),
          signer: signerGate,
          lifecycle: probeFcSourceListSummary(agentRoot, cfg),
          engagement: probeFcEngagementSummary(agentRoot, cfg, {
            status: signerProbe.status,
            mutationsAllowed: signerGate.mutationsAllowed,
          }),
        }, null, 2))
      } else {
        usage()
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
    case "fc-source":
      {
        const sub = rest[0]
        const { agentRoot, archiveRoot } = resolveHomes()
        if (sub === "review") {
          const { runFcSourceReview } = await import("./orchestrator/fc-source-list.js")
          const report = await runFcSourceReview({
            agentRoot,
            archiveRoot,
            dryRun: rest.includes("--dry-run"),
            sync: !rest.includes("--no-sync") && !rest.includes("--dry-run"),
          })
          console.log(JSON.stringify(report, null, 2))
        } else if (sub === "seed") {
          const seedPath = rest[1]
          if (!seedPath) usage()
          const { applyFcSourceSeed } = await import("./orchestrator/fc-source-seed.js")
          const report = await applyFcSourceSeed({
            agentRoot,
            archiveRoot,
            seedPath: seedPath!,
            dryRun: rest.includes("--dry-run"),
          })
          console.log(JSON.stringify(report, null, 2))
        } else if (sub === "sync") {
          const { syncFcFollowGraph } = await import("./orchestrator/fc-source-list.js")
          const receipt = await syncFcFollowGraph({
            agentRoot,
            archiveRoot,
            dryRun: rest.includes("--dry-run"),
          })
          console.log(JSON.stringify(receipt, null, 2))
          if (!receipt.verified && !rest.includes("--dry-run")) process.exit(2)
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
    case "fc-engagement":
      {
        const sub = rest[0]
        const { agentRoot, archiveRoot } = resolveHomes()
        if (sub === "status") {
          const { loadConfig } = await import("./lib/config.js")
          const { probeFcEngagementSummary } = await import("./orchestrator/fc-engagement.js")
          console.log(JSON.stringify(probeFcEngagementSummary(agentRoot, loadConfig()), null, 2))
        } else if (sub === "dry-run") {
          const runId = rest[1]
          if (!runId) usage()
          const { processFarcasterScanEngagement } = await import("./orchestrator/fc-engagement.js")
          const report = await processFarcasterScanEngagement({
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
    case "harness":
      await cmdHarness(rest)
      break
    case "auth":
      if (rest[0] === "twitter") {
        if (rest.includes("--create-managed-list")) {
          const { createAndPersistManagedList } = await import("./orchestrator/source-list.js")
          const identity = await createAndPersistManagedList()
          console.log(`Created managed list ${identity.listId}`)
          console.log(identity.listUrl)
        } else {
          const { authTwitterInteractive } = await import("./collectors/social/twitter-auth.js")
          await authTwitterInteractive()
        }
      } else if (rest[0] === "fomo") {
        const { authFomoInteractive } = await import("./collectors/social/fomo-auth.js")
        await authFomoInteractive()
      } else if (rest[0] === "farcaster") {
        await cmdAuthFarcaster(rest.slice(1))
      } else if (rest[0] === "telegram-channels") {
        await cmdAuthTelegramChannels()
      } else {
        usage()
      }
      break
    case "research":
      if (!rest[0]) usage()
      await cmdResearch(rest[0], rest.slice(1))
      break
    default:
      usage()
  }
}

async function cmdHarness(args: string[]): Promise<void> {
  const sub = args[0]
  if (!sub) usage()
  const { archiveRoot, agentRoot } = resolveHomes()
  const { loadConfig } = await import("./lib/config.js")
  const { systemClock } = await import("./lib/clock.js")
  const cfg = (() => {
    try {
      return loadConfig()
    } catch {
      return undefined
    }
  })()

  if (sub === "run") {
    const { runHarnessImprove } = await import("./harness/schedule.js")
    const report = await runHarnessImprove({
      archiveRoot,
      repoRoot: process.cwd(),
      nowIso: systemClock.nowIso(),
      dryRun: args.includes("--dry-run"),
      runTests: !args.includes("--skip-tests"),
      skipDeploy: args.includes("--skip-deploy"),
    })
    console.log(JSON.stringify(report, null, 2))
    if (report.status === "failed" || report.status === "rejected") process.exit(2)
    return
  }

  if (sub === "propose") {
    const epochIdx = args.indexOf("--epoch")
    const epochId = epochIdx >= 0 ? args[epochIdx + 1] : undefined
    if (!epochId) usage()
    const { proposeFromSealedEpoch } = await import("./harness/propose.js")
    const hyp = await proposeFromSealedEpoch({
      archiveRoot,
      epochId: epochId!,
      nowIso: systemClock.nowIso(),
      ...(cfg?.harness_improvement.min_events !== undefined
        ? { minEvents: cfg.harness_improvement.min_events }
        : {}),
      ...(cfg?.harness_improvement.min_holdout_events !== undefined
        ? { minHoldoutEvents: cfg.harness_improvement.min_holdout_events }
        : {}),
    })
    // Journal starts at created; first advance is planned (via schedule/planner)
    console.log(JSON.stringify(hyp, null, 2))
    return
  }

  if (sub === "prepare") {
    const hypothesisId = args[1]
    if (!hypothesisId) usage()
    const { prepareWorktree } = await import("./harness/prepare.js")
    const { advanceHarnessJournal } = await import("./harness/lifecycle.js")
    const { sha256Json } = await import("./lib/canonical-json.js")
    const result = await prepareWorktree({
      archiveRoot,
      hypothesisId,
      repoRoot: process.cwd(),
      nowIso: systemClock.nowIso(),
    })
    await advanceHarnessJournal(
      archiveRoot,
      hypothesisId,
      "prepared",
      sha256Json({ worktreePath: result.worktreePath } as never),
    )
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (sub === "evaluate") {
    const hypothesisId = args[1]
    const devIdx = args.indexOf("--dev-epoch")
    const holdIdx = args.indexOf("--holdout-epoch")
    const developmentEpochId = devIdx >= 0 ? args[devIdx + 1] : undefined
    const holdoutEpochId = holdIdx >= 0 ? args[holdIdx + 1] : undefined
    if (!hypothesisId || !developmentEpochId || !holdoutEpochId) usage()
    const { evaluateHypothesis } = await import("./harness/evaluate.js")
    const { advanceHarnessJournal } = await import("./harness/lifecycle.js")
    const { sha256Json } = await import("./lib/canonical-json.js")
    const evaluation = await evaluateHypothesis({
      archiveRoot,
      hypothesisId,
      developmentEpochId: developmentEpochId!,
      holdoutEpochId: holdoutEpochId!,
      repoRoot: process.cwd(),
      nowIso: systemClock.nowIso(),
      runTests: !args.includes("--skip-tests"),
    })
    if (
      evaluation.primaryImproved
      && evaluation.safetyFloorsPassed
      && evaluation.testsPassed
      && !evaluation.rejectReason
    ) {
      await advanceHarnessJournal(
        archiveRoot,
        hypothesisId,
        "holdout_evaluated",
        sha256Json(evaluation as never),
      )
    }
    console.log(JSON.stringify(evaluation, null, 2))
    if (evaluation.rejectReason) process.exit(2)
    return
  }

  if (sub === "activate") {
    const hypothesisId = args[1]
    if (!hypothesisId) usage()
    if (cfg && !cfg.harness_improvement.enabled) {
      throw new Error("harness_improvement.enabled is false")
    }
    const noWait = args.includes("--no-wait")
    const timeoutIdx = args.indexOf("--timeout-ms")
    const timeoutRaw = timeoutIdx >= 0 ? args[timeoutIdx + 1] : undefined
    const waitTimeoutMs = timeoutRaw !== undefined ? Number(timeoutRaw) : undefined
    if (timeoutRaw !== undefined && (!Number.isFinite(waitTimeoutMs) || (waitTimeoutMs ?? 0) < 0)) {
      throw new Error("--timeout-ms must be a non-negative number")
    }
    const { activateAgentWorkspace, buildDrainSnapshot, isDrainClear, waitForAgentIdle } =
      await import("./harness/drain.js")
    const { startCanary, advanceHarnessJournal } = await import("./harness/lifecycle.js")
    const { sha256Json } = await import("./lib/canonical-json.js")
    const { spawnSync } = await import("node:child_process")
    if (!noWait) {
      const waited = await waitForAgentIdle({
        agentRoot,
        archiveRoot,
        ...(waitTimeoutMs !== undefined ? { timeoutMs: waitTimeoutMs } : {}),
        onPoll: (snap) => {
          console.error(JSON.stringify({
            waiting: true,
            idle: false,
            lockHeld: snap.lockHeld,
            runningIncomplete: snap.runningIncompleteRuns,
            researching: snap.researchResearching,
            discordRunning: snap.discordRunning,
          }))
        },
      })
      if (!waited.ok) {
        console.log(JSON.stringify({ ...waited, ok: false }, null, 2))
        process.exit(2)
      }
    }
    const drain = await buildDrainSnapshot({ agentRoot, archiveRoot })
    if (!isDrainClear(drain)) {
      console.log(JSON.stringify({ ok: false, reason: "drain not clear", drain }, null, 2))
      process.exit(2)
    }
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
    })
    const sourceCommit = (head.stdout ?? "").trim()
    if (head.status !== 0 || sourceCommit.length < 7) {
      throw new Error("git rev-parse HEAD failed")
    }
    const activated = await activateAgentWorkspace({
      archiveRoot,
      hypothesisId,
      repoRoot: process.cwd(),
      agentRoot,
      sourceCommit,
      nowIso: systemClock.nowIso(),
      waitForIdle: false,
    })
    if (!activated.ok) {
      console.log(JSON.stringify(activated, null, 2))
      process.exit(2)
    }
    const state = await startCanary({
      archiveRoot,
      hypothesisId,
      allocationBps: cfg?.harness_improvement.allocation_bps ?? 1_000,
      policyVersion: `candidate:${hypothesisId}`,
    })
    await advanceHarnessJournal(
      archiveRoot,
      hypothesisId,
      "canary",
      sha256Json(state as never),
    )
    console.log(JSON.stringify({ activated: activated.manifest, canary: state }, null, 2))
    return
  }

  if (sub === "wait-idle") {
    const timeoutIdx = args.indexOf("--timeout-ms")
    const timeoutRaw = timeoutIdx >= 0 ? args[timeoutIdx + 1] : undefined
    const waitTimeoutMs = timeoutRaw !== undefined ? Number(timeoutRaw) : undefined
    if (timeoutRaw !== undefined && (!Number.isFinite(waitTimeoutMs) || (waitTimeoutMs ?? 0) < 0)) {
      throw new Error("--timeout-ms must be a non-negative number")
    }
    const { waitForAgentIdle, isAgentIdle } = await import("./harness/drain.js")
    const waited = await waitForAgentIdle({
      agentRoot,
      archiveRoot,
      ...(waitTimeoutMs !== undefined ? { timeoutMs: waitTimeoutMs } : {}),
      onPoll: (snap) => {
        console.error(JSON.stringify({
          waiting: true,
          idle: isAgentIdle(snap),
          lockHeld: snap.lockHeld,
          runningIncomplete: snap.runningIncompleteRuns,
          researching: snap.researchResearching,
          discordRunning: snap.discordRunning,
          telegramResearchRunning: snap.telegramResearchRunning,
        }))
      },
    })
    console.log(JSON.stringify(waited, null, 2))
    if (!waited.ok) process.exit(2)
    return
  }

  if (sub === "drain") {
    const { buildDrainSnapshot, isDrainClear, isAgentIdle, waitForAgentIdle } =
      await import("./harness/drain.js")
    const wantWait = args.includes("--wait")
    const timeoutIdx = args.indexOf("--timeout-ms")
    const timeoutRaw = timeoutIdx >= 0 ? args[timeoutIdx + 1] : undefined
    const waitTimeoutMs = timeoutRaw !== undefined ? Number(timeoutRaw) : undefined
    if (timeoutRaw !== undefined && (!Number.isFinite(waitTimeoutMs) || (waitTimeoutMs ?? 0) < 0)) {
      throw new Error("--timeout-ms must be a non-negative number")
    }
    if (wantWait) {
      const waited = await waitForAgentIdle({
        agentRoot,
        archiveRoot,
        ...(waitTimeoutMs !== undefined ? { timeoutMs: waitTimeoutMs } : {}),
      })
      if (!waited.ok) {
        console.log(JSON.stringify({ clear: false, idle: false, ...waited }, null, 2))
        process.exit(2)
      }
    }
    const snapshot = await buildDrainSnapshot({ agentRoot, archiveRoot })
    console.log(JSON.stringify({
      clear: isDrainClear(snapshot),
      idle: isAgentIdle(snapshot),
      snapshot,
    }, null, 2))
    return
  }

  if (sub === "canary") {
    const action = args[1]
    if (action === "start") {
      const hypothesisId = args[2]
      if (!hypothesisId) usage()
      if (cfg && !cfg.harness_improvement.enabled) {
        throw new Error("harness_improvement.enabled is false")
      }
      const { startCanary } = await import("./harness/lifecycle.js")
      const { advanceHarnessJournal } = await import("./harness/lifecycle.js")
      const { sha256Json } = await import("./lib/canonical-json.js")
      const state = await startCanary({
        archiveRoot,
        hypothesisId,
        allocationBps: cfg?.harness_improvement.allocation_bps ?? 1_000,
        policyVersion: `candidate:${hypothesisId}`,
      })
      await advanceHarnessJournal(
        archiveRoot,
        hypothesisId,
        "canary",
        sha256Json(state as never),
      )
      console.log(JSON.stringify(state, null, 2))
      return
    }
    if (action === "stop") {
      const reasonIdx = args.indexOf("--reason")
      const reason = reasonIdx >= 0 ? args[reasonIdx + 1] : "operator stop"
      const { stopCanary } = await import("./harness/lifecycle.js")
      const state = await stopCanary({ archiveRoot, reason: reason ?? "operator stop" })
      console.log(JSON.stringify(state, null, 2))
      return
    }
    usage()
  }

  if (sub === "status") {
    const { canaryStatus } = await import("./harness/lifecycle.js")
    console.log(JSON.stringify(canaryStatus(archiveRoot), null, 2))
    return
  }

  if (sub === "promote") {
    const hypothesisId = args[1]
    if (!hypothesisId) usage()
    const { promoteHypothesis, advanceHarnessJournal } = await import("./harness/lifecycle.js")
    const { sha256Json } = await import("./lib/canonical-json.js")
    await promoteHypothesis({ archiveRoot, hypothesisId })
    await advanceHarnessJournal(
      archiveRoot,
      hypothesisId,
      "complete",
      sha256Json({ promoted: true, hypothesisId } as never),
    )
    console.log(JSON.stringify({ promoted: hypothesisId }, null, 2))
    return
  }

  if (sub === "rollback") {
    const reasonIdx = args.indexOf("--reason")
    const reason = reasonIdx >= 0 ? args[reasonIdx + 1] : "operator rollback"
    const { stopCanary } = await import("./harness/lifecycle.js")
    const state = await stopCanary({
      archiveRoot,
      reason: reason ?? "operator rollback",
      rollbackHypothesis: true,
    })
    console.log(JSON.stringify(state, null, 2))
    return
  }

  usage()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

import { mkdirSync, writeFileSync, existsSync, cpSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { loadDotEnv } from "./lib/dotenv.js"
import { ConfigSchema } from "./lib/config.js"
import { migrateConfigToV28 } from "./migrations/config.js"
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
  run fail <run-id> [--reason <text>]
  precheck <job>
  config validate
  config migrate --write
  outcomes settle
  delivery retry
  undock <id>
  confirm <id>
  status [--heal] [--heal-apply] [--json]
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
  wallets add-candidates <path> [--dry-run]
  x-engagement dry-run <run-id>
  x-engagement status
  fc-engagement dry-run <run-id>
  fc-engagement status
  pump-engagement dry-run <run-id>
  pump-engagement status
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
  harness meta propose [--candidate-id <id>]
  harness meta trial --candidate <id> --dev-epoch <id> --holdout-epoch <id>
  harness meta status
  harness meta promote <candidate-id>
  harness meta reject <candidate-id>
  broadcast feedback status|ledger|seal|reconcile
  broadcast feedback candidate [--dataset <id>]
  broadcast feedback apply <candidate-id>
  broadcast feedback dismiss <candidate-id>
  router serve
  listen [telegram|discord|channels|x-scan]
  discord watchlist scan
  discord chains run|status|retry|fail|continue
  remediations scan|run|status|suggestions|approve|defer|reject|retry|fail
  backup
  research <subject>
  auth twitter [--create-managed-list] [--headed]
  auth fomo [--headed]
  auth pump [--headed]
  auth pump --status
  auth pump --refresh [--headed]
  auth pump --import <storage-state.json>
  auth pump --import-cookies <json> [--import-local-storage <json>]
  auth pump --import-cookie-header <file> [--import-local-storage <json>]
  auth farcaster --create --fname <name>
  auth farcaster --fid <n> --username <name> --mnemonic-stdin
  auth telegram-channels
  jobs
`)
  process.exit(1)
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx < 0) return undefined
  const value = args[idx + 1]
  if (!value || value.startsWith("-")) usage()
  return value
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
  const cfg = ConfigSchema.parse(migrateConfigToV28(raw))
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

async function cmdWalletsAddCandidates(seedPath: string, dryRun: boolean): Promise<void> {
  const { agentRoot, archiveRoot } = resolveHomes()
  const { applyOperatorWalletCandidates } = await import("./orchestrator/wallet-add-candidates.js")
  const report = await applyOperatorWalletCandidates({
    agentRoot,
    archiveRoot,
    seedPath,
    dryRun,
  })
  console.log(JSON.stringify(report, null, 2))
}

async function cmdRun(jobName: string, args: string[]): Promise<void> {
  if (jobName === "fail") {
    const runId = args[0]
    if (!runId) usage()
    const reasonIdx = args.indexOf("--reason")
    const reason = reasonIdx >= 0
      ? (args[reasonIdx + 1] ?? "operator fail")
      : "operator fail"
    const { agentRoot, archiveRoot } = resolveHomes()
    const { failRunJournal } = await import("./orchestrator/abandon.js")
    const journal = await failRunJournal({
      archiveRoot,
      agentRoot,
      runId,
      code: "operator-abandon",
      message: reason,
    })
    console.log(JSON.stringify({
      runId: journal.runId,
      status: journal.status,
      phase: journal.phase,
      failure: journal.failure ?? null,
    }, null, 2))
    return
  }
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
  const { agentRoot, archiveRoot } = resolveHomes()
  const home = join(homedir(), ".trenchcoat")
  const { loadConfig } = await import("./lib/config.js")
  const { runTelegramChannelsListener } = await import("./collectors/telegram/channels.js")
  const { createTelegramAlphaPump } = await import("./orchestrator/telegram-alpha.js")
  const cfg = loadConfig()
  const channels = cfg.telegram_channels.map((c) => ({
    channel: c.channel,
    mode: c.mode,
  }))
  const pump = createTelegramAlphaPump({
    paths: { agentRoot, archiveRoot },
  })
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
      onNewMessage: ({ queuePath }) => {
        pump.enqueue(queuePath)
      },
    })
  } catch (error) {
    if (ac.signal.aborted) return
    throw error
  }
}

async function cmdListenXScan(): Promise<void> {
  const { agentRoot, archiveRoot } = resolveHomes()
  const home = join(homedir(), ".trenchcoat")
  const { runXScanLoop } = await import("./orchestrator/x-scan-loop.js")
  const ac = new AbortController()
  const stop = (): void => {
    ac.abort()
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  try {
    await runXScanLoop({
      paths: { agentRoot, archiveRoot },
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

async function cmdRemediations(rest: string[]): Promise<void> {
  const repoRoot = process.env["TRENCHCOAT_REPO_ROOT"]
    ?? join(homedir(), "Documents", "trench-bot")
  const root = existsSync(join(process.cwd(), "ops", "install-launchd.sh"))
    ? process.cwd()
    : (existsSync(join(repoRoot, "ops", "install-launchd.sh")) ? repoRoot : process.cwd())

  const {
    runRemediationWorker,
    scanRemediationIncidents,
    handleRemediationChatCommand,
    remediationStatusSummary,
  } = await import("./remediation/orchestrate.js")
  const { createRemediationStore, upsertIncident } = await import("./remediation/store.js")
  const { remediationLayout } = await import("./remediation/paths.js")
  const { systemClock } = await import("./lib/clock.js")

  const sub = rest[0]
  if (sub === "status") {
    console.log(JSON.stringify(remediationStatusSummary(), null, 2))
    return
  }
  if (sub === "suggestions") {
    const { listSuggestionLedger } = await import("./remediation/suggestions.js")
    const ledger = listSuggestionLedger(createRemediationStore(remediationLayout()))
    console.log(JSON.stringify(ledger, null, 2))
    return
  }
  if (sub === "scan") {
    const result = await scanRemediationIncidents({ repoRoot: root })
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (sub === "run") {
    const weekly = rest.includes("--weekly")
    const id = rest.find((a) => a.startsWith("rem-"))
    const result = await runRemediationWorker({
      repoRoot: root,
      weekly,
      ...(id ? { incidentId: id } : {}),
    })
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok && result.detail !== "idle" && result.detail !== "worker busy"
      && result.detail !== "awaiting-approval" && result.detail !== "disabled"
      && result.detail !== "repo-mutation-lock-held" && result.detail !== "daily-build-cap") {
      process.exit(1)
    }
    return
  }
  if (sub === "approve" || sub === "defer" || sub === "reject") {
    const id = rest[1]
    if (!id) usage()
    const operatorId = process.env["TELEGRAM_OPERATOR_ID"] ?? "cli-operator"
    const reply = await handleRemediationChatCommand({
      text: `${sub} remediation ${id}`,
      operatorId,
      repoRoot: root,
    })
    console.log(reply ?? "no-op")
    return
  }
  if (sub === "retry") {
    const id = rest[1]
    if (!id) usage()
    const store = createRemediationStore(remediationLayout())
    const incident = store.findById(id)
    if (!incident) {
      console.error("unknown incident")
      process.exit(2)
    }
    let file = store.load()
    file = upsertIncident(file, {
      ...incident,
      phase: "triaged",
      terminalError: undefined,
      preReviewReviseCount: 0,
      updatedAt: systemClock.nowIso(),
    })
    file = { ...file, activeIncidentId: id }
    await store.save(file)
    const result = await runRemediationWorker({ repoRoot: root, incidentId: id })
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (sub === "fail") {
    const id = rest[1]
    if (!id) usage()
    const reason = rest.slice(2).join(" ").slice(0, 280) || "operator fail"
    const store = createRemediationStore(remediationLayout())
    const incident = store.findById(id)
    if (!incident) {
      console.error("unknown incident")
      process.exit(2)
    }
    let file = store.load()
    file = upsertIncident(file, {
      ...incident,
      phase: "failed",
      terminalError: reason,
      updatedAt: systemClock.nowIso(),
    })
    if (file.activeIncidentId === id) file = { ...file, activeIncidentId: null }
    await store.save(file)
    const { clearIntegrityHoldForIncident } = await import("./remediation/integrity-hold.js")
    await clearIntegrityHoldForIncident(id)
    console.log(JSON.stringify({ ok: true, incidentId: id, phase: "failed" }, null, 2))
    return
  }
  usage()
}

async function cmdDiscordChains(rest: string[]): Promise<void> {
  const repoRoot = process.env["TRENCHCOAT_REPO_ROOT"]
    ?? join(homedir(), "Documents", "trench-bot")
  const root = existsSync(join(process.cwd(), "ops", "install-launchd.sh"))
    ? process.cwd()
    : (existsSync(join(repoRoot, "ops", "install-launchd.sh")) ? repoRoot : process.cwd())

  const {
    runChainIntegrationWorker,
    loadChainIntegrationStatus,
  } = await import("./chain-integration/orchestrate.js")
  const {
    createChainIntegrationStore,
  } = await import("./chain-integration/store.js")
  const { chainIntegrationLayout } = await import("./chain-integration/paths.js")
  const { systemClock } = await import("./lib/clock.js")

  const sub = rest[0]
  if (sub === "status") {
    const status = loadChainIntegrationStatus()
    console.log(JSON.stringify(status, null, 2))
    return
  }
  if (sub === "run") {
    const result = await runChainIntegrationWorker({ repoRoot: root })
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok && result.detail !== "idle" && result.detail !== "worker busy") {
      process.exit(1)
    }
    return
  }
  if (sub === "retry") {
    const id = rest[1]
    const store = createChainIntegrationStore(chainIntegrationLayout())
    const file = store.load()
    const target = id
      ? file.integrations.find((i) => i.integrationId === id)
      : [...file.integrations].reverse().find((i) => i.phase === "failed")
    if (!target) {
      console.error("no failed integration to retry")
      process.exit(2)
    }
    const idx = file.integrations.findIndex((i) => i.integrationId === target.integrationId)
    file.integrations[idx] = {
      ...target,
      phase: "queued",
      terminalError: undefined,
      updatedAt: systemClock.nowIso(),
      repairRound: 0,
      providerAttempts: 0,
      deployAttempts: 0,
    }
    if (!file.activeIntegrationId) file.activeIntegrationId = target.integrationId
    await store.save(file)
    const result = await runChainIntegrationWorker({
      repoRoot: root,
      integrationId: target.integrationId,
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (sub === "continue") {
    const id = rest[1]
    if (!id) usage()
    const {
      continueAfterDeploy,
    } = await import("./chain-integration/orchestrate.js")
    const result = await continueAfterDeploy({
      integrationId: id,
      repoRoot: root,
    })
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) process.exit(1)
    return
  }
  if (sub === "fail") {
    const id = rest[1]
    if (!id) usage()
    const reason = rest.slice(2).join(" ").slice(0, 280) || "operator fail"
    const store = createChainIntegrationStore(chainIntegrationLayout())
    const file = store.load()
    const idx = file.integrations.findIndex((i) => i.integrationId === id)
    if (idx < 0) {
      console.error("integration not found")
      process.exit(2)
    }
    const record = file.integrations[idx]!
    file.integrations[idx] = {
      ...record,
      phase: "failed",
      terminalError: reason,
      updatedAt: systemClock.nowIso(),
    }
    if (file.activeIntegrationId === id) file.activeIntegrationId = null
    await store.save(file)
    const {
      failIntegrationSources,
      resolveDiscordBotToken,
    } = await import("./chain-integration/continue.js")
    await failIntegrationSources(record, resolveDiscordBotToken())
    console.log(JSON.stringify({ ok: true, integrationId: id, phase: "failed" }))
    return
  }
  usage()
}

async function cmdListenTelegram(): Promise<void> {
  const token = process.env["TELEGRAM_BOT_TOKEN"]
  const operatorId = process.env["TELEGRAM_OPERATOR_ID"]
  if (!token || !operatorId) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_OPERATOR_ID required")

  const home = join(homedir(), ".trenchcoat")
  const { agentRoot, archiveRoot } = resolveHomes()
  let idleTimeoutMinutes = 30
  let turnCountMax = 40
  let maxPromptChars = 12_000
  let researchConfirmTtlMinutes = 15
  const configPath = join(home, "config.json")
  if (existsSync(configPath)) {
    const { loadConfig } = await import("./lib/config.js")
    const cfg = loadConfig(configPath)
    idleTimeoutMinutes = cfg.chat.idle_timeout_minutes
    turnCountMax = cfg.chat.turn_count_max
    maxPromptChars = cfg.chat.max_prompt_chars
    researchConfirmTtlMinutes = cfg.chat.research_confirm_ttl_minutes
  }

  const runTurn = createChatTurnRunner({
    agentRoot,
    telegramUserId: operatorId,
    idleTimeoutMinutes,
    turnCountMax,
    maxPromptChars,
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
          reply_to_message?: { message_id?: number }
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
      const { parseChatDirectives } = await import("./chat/directives.js")
      const directives = parseChatDirectives(trimmed)
      const body = directives.body
      const hostHandled = directives.directiveOnly
        || trimmed.startsWith("/status")
        || trimmed.startsWith("/start")
        || /^(undock|confirm)\s+\S+/iu.test(trimmed)
        || /^(approve|defer|reject)\s+remediation\b/iu.test(trimmed)
        || /^\/?remediations?\b/iu.test(trimmed)
        || /^(confirm|yes|y|do\s+it|go\s+ahead|approved?|cancel|no|n|never\s*mind|abort|stop)\s*[!.]*$/iu.test(body)
        || /^[1-5]\s*$/u.test(body)
        || /\b(research|deep\s+research|look\s*into|deep[\s-]?dive|investigate|dig\s+into)\b/iu.test(body)
        || /^\/research\b/iu.test(body)
        || /^(solana|ethereum|base|bsc|robinhood|plasma|hyperliquid|hyperevm):[A-Za-z0-9]{32,128}$/iu.test(body)
        || /^[a-z][a-z0-9-]{1,31}:[A-Za-z0-9]{32,128}$/iu.test(body)
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
          ...(msg.reply_to_message?.message_id
            ? { replyToMessageId: String(msg.reply_to_message.message_id) }
            : {}),
          broadcastFeedback: {
            handle: async (feedback) => {
              const { loadConfig } = await import("./lib/config.js")
              const cfg = loadConfig()
              if (!cfg.broadcast.feedback.enabled) return null
              const { handleFeedbackReply } = await import("./broadcast-feedback/followup.js")
              const { resolveHarnessRepoRoot } = await import("./harness/pr.js")
              const { systemClock } = await import("./lib/clock.js")
              return handleFeedbackReply({
                text: feedback.text,
                ...(feedback.replyToMessageId
                  ? { replyToMessageId: feedback.replyToMessageId }
                  : {}),
                repoRoot: resolveHarnessRepoRoot(),
                model: cfg.broadcast.feedback.followup_model,
                nowIso: systemClock.nowIso(),
              })
            },
          },
          remediation: {
            handle: async (text, opId) => {
              const { handleRemediationChatCommand } = await import("./remediation/orchestrate.js")
              const { resolveHarnessRepoRoot } = await import("./harness/pr.js")
              return handleRemediationChatCommand({
                text,
                operatorId: opId,
                repoRoot: resolveHarnessRepoRoot(),
              })
            },
          },
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
  const { normalizeChainSlug, parseChainCa } = await import("./lib/chains.js")
  const chained = parseChainCa(subject)
  const chainedSlug = chained ? normalizeChainSlug(chained.chainRaw) : undefined
  const result = await runOperatorResearchNow({
    paths: { agentRoot, archiveRoot },
    input: {
      subject: intent.subject ?? subject,
      provenance: ["operator:cli"],
      reason: "cli research",
      ...(chainedSlug
        ? { chainHint: chainedSlug as never }
        : intent.chainHint
          ? { chainHint: intent.chainHint }
          : {}),
      ...(chained?.token
        ? { tokenHint: chained.token }
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
      if (rest[0] === "seed" && rest[1]) {
        await cmdWalletsSeed(rest[1]!)
        break
      }
      if (rest[0] === "add-candidates" && rest[1]) {
        await cmdWalletsAddCandidates(rest[1]!, rest.includes("--dry-run"))
        break
      }
      usage()
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
        let remediation: Record<string, unknown> | undefined
        try {
          const { remediationStatusSummary } = await import("./remediation/orchestrate.js")
          remediation = remediationStatusSummary()
        } catch {
          remediation = undefined
        }
        console.log(JSON.stringify({
          preflight: { ok: pf.ok && configOk && runtimeOk, checks: pf.checks },
          health: toHealthJsonPayload(health),
          ...(discordStatus ? { discord: discordStatus } : {}),
          ...(remediation ? { remediation } : {}),
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
        try {
          const { loadConfig } = await import("./lib/config.js")
          const cfg = loadConfig()
          if (cfg.chat.discord.enabled && cfg.chat.discord.chain_integration.enabled) {
            const { loadChainIntegrationStatus } = await import("./chain-integration/orchestrate.js")
            const ci = loadChainIntegrationStatus()
            console.log("")
            console.log("Discord chain integration:")
            console.log(`  attemptsToday=${ci.attemptsToday}/${ci.maxAttempts} queued=${ci.queued}`)
            if (ci.activeIntegrationId) {
              console.log(`  active=${ci.activeIntegrationId} phase=${ci.phase ?? "?"} slug=${ci.slug ?? "?"}`)
              if (ci.baseCommit) console.log(`  base=${ci.baseCommit.slice(0, 12)}`)
              if (ci.candidateCommit) console.log(`  candidate=${ci.candidateCommit.slice(0, 12)}`)
            }
            if (ci.lastFailure) console.log(`  lastFailure: ${ci.lastFailure}`)
            console.log("  recovery: tc discord chains status|retry|fail")
          }
        } catch {
          // best-effort
        }
      }

        try {
          const { remediationStatusSummary } = await import("./remediation/orchestrate.js")
          const rem = remediationStatusSummary()
          if (wantJson) {
            // already printed above — include via separate path below
          } else {
            console.log("")
            console.log("Incident remediation:")
            console.log(`  enabled=${rem["enabled"]} active=${rem["activeIncidentId"] ?? "none"}`)
            console.log(`  pendingApprovals=${rem["pendingApprovals"]} deferred=${rem["deferredCount"]}`)
            if (rem["lastScanAt"]) console.log(`  lastScan=${rem["lastScanAt"]}`)
            if (rem["automationHalted"]) {
              console.log(`  HALTED: ${rem["automationHaltReason"] ?? "unknown"}`)
            }
            console.log("  recovery: tc remediations status|approve|defer|reject")
          }
        } catch {
          // best-effort
        }

      if (rest.includes("--heal") || rest.includes("--heal-apply")) {
        const { listIncompleteRuns } = await import("./orchestrator/run.js")
        const incomplete = await listIncompleteRuns(archiveRoot)
        if (incomplete.length === 0) {
          console.log("heal: no incomplete runs")
        } else {
          for (const run of incomplete) {
            console.log(`heal: incomplete run ${run.runId}${run.quarantined ? " (quarantined — needs operator review)" : ""}`)
          }
        }
        if (rest.includes("--heal-apply")) {
          const { abandonOrphanedRuns } = await import("./orchestrator/abandon.js")
          const result = await abandonOrphanedRuns({
            agentRoot,
            archiveRoot,
            includeCreatedAbandoned: true,
          })
          console.log(`heal-apply: failed=${result.failed.length} skipped=${result.skipped.length}`)
          for (const id of result.failed) console.log(`heal-apply: failed ${id}`)
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
      } else if (rest[0] === "x-scan") {
        await cmdListenXScan()
      } else if (rest[0] === undefined) {
        await cmdListenAll()
      } else {
        usage()
      }
      break
    case "discord":
      if (rest[0] === "watchlist" && rest[1] === "scan") {
        await cmdDiscordWatchlistScan()
      } else if (rest[0] === "chains") {
        await cmdDiscordChains(rest.slice(1))
      } else {
        usage()
      }
      break
    case "remediations":
      await cmdRemediations(rest)
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
    case "pump-engagement":
      {
        const sub = rest[0]
        const { agentRoot, archiveRoot } = resolveHomes()
        if (sub === "status") {
          const { loadConfig } = await import("./lib/config.js")
          const { probePumpEngagementSummary } = await import("./orchestrator/pump-engagement.js")
          console.log(JSON.stringify(probePumpEngagementSummary(agentRoot, loadConfig()), null, 2))
        } else if (sub === "dry-run") {
          const runId = rest[1]
          if (!runId) usage()
          const { processPumpScanEngagement } = await import("./orchestrator/pump-engagement.js")
          const report = await processPumpScanEngagement({
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
    case "broadcast":
      if (rest[0] === "feedback") {
        await cmdBroadcastFeedback(rest.slice(1))
      } else {
        usage()
      }
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
      } else if (rest[0] === "pump") {
        const flags = rest.slice(1)
        const storageStatePath = flagValue(flags, "--import")
        const cookiesPath = flagValue(flags, "--import-cookies")
        const cookieHeaderPath = flagValue(flags, "--import-cookie-header")
        const cookieDomain = flagValue(flags, "--cookie-domain")
        const localStoragePath = flagValue(flags, "--import-local-storage")
        const wantStatus = flags.includes("--status")
        const wantRefresh = flags.includes("--refresh")
        if (wantStatus && wantRefresh) usage()
        if ((wantStatus || wantRefresh) && (
          storageStatePath || cookiesPath || cookieHeaderPath || localStoragePath
        )) {
          usage()
        }
        if (wantStatus) {
          const { inspectPumpSession } = await import("./collectors/social/pump-auth.js")
          const result = inspectPumpSession()
          console.log(`session → ${result.path}`)
          console.log(
            `looks_authed=${result.looksAuthed} cookies=${result.cookieCount}`
              + ` identity_cookies=${result.identityCookieCount}`
              + ` localStorage=${result.localStorageCount}`,
          )
        } else if (wantRefresh) {
          const { refreshPumpSession } = await import("./collectors/social/pump-auth.js")
          const result = await refreshPumpSession({
            headless: !flags.includes("--headed"),
          })
          console.log(`session → ${result.path}`)
          console.log(
            `looks_authed=${result.looksAuthed} wrote=${result.wrote}`
              + ` cookies=${result.cookieCount}`
              + ` identity_cookies=${result.identityCookieCount}`
              + ` localStorage=${result.localStorageCount}`,
          )
          if (!result.looksAuthed) {
            console.warn("warning: refresh left no Privy identity token — re-import the burner")
            process.exitCode = 2
          }
        } else if (storageStatePath || cookiesPath || cookieHeaderPath || localStoragePath) {
          const { importPumpSession } = await import("./collectors/social/pump-auth.js")
          const result = await importPumpSession({
            ...(storageStatePath ? { storageStatePath } : {}),
            ...(cookiesPath ? { cookiesPath } : {}),
            ...(cookieHeaderPath ? { cookieHeaderPath } : {}),
            ...(cookieDomain ? { cookieDomain } : {}),
            ...(localStoragePath ? { localStoragePath } : {}),
          })
          console.log(`Imported burner session → ${result.path}`)
          console.log(`cookies=${result.cookieCount} localStorage=${result.localStorageCount}`)
          if (!result.looksAuthed) {
            console.warn("warning: imported session has no Privy identity token")
          }
        } else {
          const { authPumpInteractive } = await import("./collectors/social/pump-auth.js")
          await authPumpInteractive()
        }
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

/**
 * Operator commands for broadcast feedback (ADR 043). Decision signals and
 * verdicts come from archived decision bundles, so a sealed dataset carries
 * only host-recorded numbers.
 */
async function cmdBroadcastFeedback(args: string[]): Promise<void> {
  const sub = args[0]
  if (!sub) usage()
  const { archiveRoot } = resolveHomes()
  const { systemClock } = await import("./lib/clock.js")
  const { loadConfig } = await import("./lib/config.js")
  const { resolveHarnessRepoRoot } = await import("./harness/pr.js")
  const {
    feedbackApply,
    feedbackCandidate,
    feedbackDismiss,
    feedbackLedgerView,
    feedbackReconcile,
    feedbackSeal,
    feedbackStatus,
  } = await import("./broadcast-feedback/cli.js")
  const { decisionBundleLookups } = await import("./broadcast-feedback/decision-lookup.js")

  const cfg = loadConfig()
  const lookups = decisionBundleLookups(archiveRoot)
  const deps = {
    repoRoot: resolveHarnessRepoRoot(),
    nowIso: systemClock.nowIso(),
    signals: lookups.signals,
    verdicts: lookups.verdicts,
    floors: {
      minPolicyExamples: cfg.broadcast.feedback.candidate_min_policy_examples,
      minCompletedDown: cfg.broadcast.feedback.candidate_min_completed_down,
      minPreferencePairs: cfg.broadcast.feedback.candidate_min_preference_pairs,
    },
  }

  if (sub === "status") {
    console.log(JSON.stringify(feedbackStatus(deps), null, 2))
    return
  }
  if (sub === "ledger") {
    console.log(JSON.stringify(feedbackLedgerView(deps), null, 2))
    return
  }
  if (sub === "seal") {
    console.log(JSON.stringify(feedbackSeal(deps), null, 2))
    return
  }
  if (sub === "candidate") {
    const datasetIdx = args.indexOf("--dataset")
    const datasetId = datasetIdx >= 0 ? args[datasetIdx + 1] : undefined
    console.log(JSON.stringify(
      feedbackCandidate({ ...deps, ...(datasetId ? { datasetId } : {}) }),
      null,
      2,
    ))
    return
  }
  if (sub === "apply" || sub === "dismiss") {
    const candidateId = args[1]
    if (!candidateId) usage()
    const result = sub === "apply"
      ? feedbackApply({ ...deps, candidateId: candidateId! })
      : feedbackDismiss({ ...deps, candidateId: candidateId! })
    console.log(JSON.stringify({ ok: true, [sub]: result }, null, 2))
    return
  }
  if (sub === "reconcile") {
    console.log(JSON.stringify({ expired: await feedbackReconcile(deps) }, null, 2))
    return
  }
  usage()
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
    const { resolveHarnessRepoRoot } = await import("./harness/pr.js")
    const report = await runHarnessImprove({
      archiveRoot,
      repoRoot: resolveHarnessRepoRoot(),
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
    const { resolveHarnessRepoRoot } = await import("./harness/pr.js")
    const hyp = await proposeFromSealedEpoch({
      archiveRoot,
      epochId: epochId!,
      nowIso: systemClock.nowIso(),
      repoRoot: resolveHarnessRepoRoot(),
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
    const { resolveHarnessRepoRoot } = await import("./harness/pr.js")
    const harnessRepoRoot = resolveHarnessRepoRoot()
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: harnessRepoRoot,
      encoding: "utf8",
    })
    const sourceCommit = (head.stdout ?? "").trim()
    if (head.status !== 0 || sourceCommit.length < 7) {
      throw new Error("git rev-parse HEAD failed")
    }
    const activated = await activateAgentWorkspace({
      archiveRoot,
      hypothesisId,
      repoRoot: harnessRepoRoot,
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
    const { harnessStatusSnapshot } = await import("./harness/readiness.js")
    const config = cfg?.harness_improvement ?? {
      enabled: true,
      schedule_enabled: true,
      require_two_epochs: true,
      one_active_experiment: true,
      min_events: 40,
      min_holdout_events: 20,
    }
    console.log(JSON.stringify(harnessStatusSnapshot({
      archiveRoot,
      config: {
        enabled: config.enabled,
        schedule_enabled: config.schedule_enabled,
        require_two_epochs: config.require_two_epochs,
        one_active_experiment: config.one_active_experiment,
        min_events: config.min_events,
        min_holdout_events: config.min_holdout_events,
      },
    }), null, 2))
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

  if (sub === "meta") {
    const action = args[1]
    const { resolveHarnessRepoRoot } = await import("./harness/pr.js")
    const repoRoot = resolveHarnessRepoRoot()
    if (action === "propose") {
      const idIdx = args.indexOf("--candidate-id")
      const candidateId = idIdx >= 0 ? args[idIdx + 1] : undefined
      const { proposeMetaCandidateFromPrior } = await import("./harness/meta-propose.js")
      const candidate = await proposeMetaCandidateFromPrior({
        archiveRoot,
        repoRoot,
        nowIso: systemClock.nowIso(),
        ...(candidateId ? { candidateId } : {}),
      })
      console.log(JSON.stringify(candidate, null, 2))
      return
    }
    if (action === "trial") {
      const candIdx = args.indexOf("--candidate")
      const candidateId = candIdx >= 0 ? args[candIdx + 1] : undefined
      const devIdx = args.indexOf("--dev-epoch")
      const holdIdx = args.indexOf("--holdout-epoch")
      const developmentEpochId = devIdx >= 0 ? args[devIdx + 1] : undefined
      const holdoutEpochId = holdIdx >= 0 ? args[holdIdx + 1] : undefined
      if (!candidateId || !developmentEpochId || !holdoutEpochId) usage()
      const { setMetaCandidateStatus } = await import("./harness/meta-propose.js")
      const { runMetaTrialPair, recomputeAndSaveUtility } = await import("./harness/meta-trial.js")
      await setMetaCandidateStatus({
        archiveRoot,
        candidateId: candidateId!,
        status: "trialing",
      })
      const pair = await runMetaTrialPair({
        archiveRoot,
        repoRoot,
        candidateId: candidateId!,
        developmentEpochId: developmentEpochId!,
        holdoutEpochId: holdoutEpochId!,
        nowIso: systemClock.nowIso(),
      })
      const utility = await recomputeAndSaveUtility({
        archiveRoot,
        candidateId: candidateId!,
        nowIso: systemClock.nowIso(),
      })
      if (utility.promotionEligible) {
        const eligible = await setMetaCandidateStatus({
          archiveRoot,
          candidateId: candidateId!,
          status: "promotion_eligible",
        })
        const { notifyMetaPromotionEligible } = await import(
          "./harness/meta-operator-notify.js"
        )
        await notifyMetaPromotionEligible({
          archiveRoot,
          candidate: eligible,
          utility,
          nowIso: systemClock.nowIso(),
        })
      }
      console.log(JSON.stringify({ pair, utility }, null, 2))
      return
    }
    if (action === "status") {
      const { metaStatusSnapshot } = await import("./harness/meta-propose.js")
      console.log(JSON.stringify(metaStatusSnapshot(archiveRoot), null, 2))
      return
    }
    if (action === "promote") {
      const candidateId = args[2]
      if (!candidateId) usage()
      const { promoteMetaCandidate } = await import("./harness/meta-propose.js")
      const result = await promoteMetaCandidate({
        archiveRoot,
        repoRoot,
        candidateId,
        nowIso: systemClock.nowIso(),
      })
      console.log(JSON.stringify(result, null, 2))
      if (!result.ok) process.exit(2)
      return
    }
    if (action === "reject") {
      const candidateId = args[2]
      if (!candidateId) usage()
      const { rejectMetaCandidate } = await import("./harness/meta-propose.js")
      const rejected = await rejectMetaCandidate({
        archiveRoot,
        candidateId,
        nowIso: systemClock.nowIso(),
      })
      console.log(JSON.stringify(rejected, null, 2))
      return
    }
    usage()
  }

  usage()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

import { mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { writeAtomicFileFsync, sha256Bytes } from "../lib/fs-atomic.js"
import { WorkspaceLock } from "../lib/lock.js"
import { systemClock } from "../lib/clock.js"
import { loadConfig } from "../lib/config.js"
import { log } from "../lib/log.js"
import { probeCursorCli } from "../orchestrator/session.js"
import {
  runChainBuildAgent,
  runChainFinalizeAgent,
  runChainResearchAgent,
  validateFinalReview,
  validateResearchProposal,
} from "./agents.js"
import {
  evaluateBuildConfinement,
  evaluateFinalizeConfinement,
  listRepoChainSlugs,
} from "./confinement.js"
import {
  announceIntegrationSuccess,
  failIntegrationSources,
  handoffToResearchFifo,
  reactAcceptedSources,
  resolveDiscordBotToken,
  verifyPostDeployHealth,
} from "./continue.js"
import { collectChainEvidence } from "./evidence.js"
import { runCleanGate } from "./gates.js"
import { nextQueuedIntegration } from "./intake.js"
import {
  chainIntegrationLayout,
  integrationArtifactDir,
} from "./paths.js"
import {
  assertCleanMain,
  commitIntegration,
  deployIntegration,
  fetchOriginMain,
  prepareWorktree,
  PublishError,
  pushAndFastForward,
  revertAndRedeploy,
} from "./publish.js"
import {
  appendJournalLine,
  createChainIntegrationStore,
} from "./store.js"
import type { ChainIntegrationPhase, ChainIntegrationRecord } from "./schemas.js"
import { ACTIVE_INTEGRATION_PHASES } from "./schemas.js"

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function updateRecord(
  integrationId: string,
  patch: Partial<ChainIntegrationRecord>,
): Promise<ChainIntegrationRecord> {
  const layout = chainIntegrationLayout()
  const store = createChainIntegrationStore(layout)
  const lock = new WorkspaceLock(layout.lock)
  if (!lock.tryAcquire()) throw new Error("chain-integration lock busy")
  try {
    const file = store.load()
    const idx = file.integrations.findIndex((i) => i.integrationId === integrationId)
    if (idx < 0) throw new Error("integration missing")
    const next = {
      ...file.integrations[idx]!,
      ...patch,
      updatedAt: systemClock.nowIso(),
    }
    file.integrations[idx] = next
    if (
      (ACTIVE_INTEGRATION_PHASES as readonly string[]).includes(next.phase)
      && next.phase !== "queued"
    ) {
      file.activeIntegrationId = integrationId
    }
    if (next.phase === "completed" || next.phase === "failed") {
      if (file.activeIntegrationId === integrationId) file.activeIntegrationId = null
    }
    await store.save(file)
    return next
  } finally {
    lock.release()
  }
}

async function markFailed(
  record: ChainIntegrationRecord,
  reason: string,
  token?: string,
): Promise<void> {
  const sanitized = reason.slice(0, 280)
  await updateRecord(record.integrationId, {
    phase: "failed",
    terminalError: sanitized,
    workerPid: undefined,
  })
  await appendJournalLine(chainIntegrationLayout(), record.integrationId, {
    event: "failed",
    reason: sanitized,
  })
  await failIntegrationSources(record, token)
}

export async function runChainIntegrationWorker(args: Readonly<{
  repoRoot: string
  integrationId?: string
}>): Promise<{ ok: boolean; detail?: string }> {
  const config = loadConfig()
  const ci = config.chat.discord.chain_integration
  if (!ci.enabled) return { ok: false, detail: "disabled" }

  const layout = chainIntegrationLayout()
  const worker = new WorkspaceLock(layout.workerLock)
  if (!worker.tryAcquire()) return { ok: false, detail: "worker busy" }

  const token = resolveDiscordBotToken()
  try {
    const store = createChainIntegrationStore(layout)
    let file = store.load()
    let record = args.integrationId
      ? store.findById(args.integrationId)
      : file.activeIntegrationId
        ? store.findById(file.activeIntegrationId)
        : nextQueuedIntegration(file)

    if (!record || record.phase === "completed" || record.phase === "failed") {
      record = nextQueuedIntegration(file)
    }
    if (!record) return { ok: true, detail: "idle" }

    record = await updateRecord(record.integrationId, {
      workerPid: process.pid,
      phase: record.phase === "queued" ? "collecting" : record.phase,
    })
    await appendJournalLine(layout, record.integrationId, {
      event: "worker-start",
      phase: record.phase,
      pid: process.pid,
    })

    if (token) await reactAcceptedSources(record, token)

    try {
      await runPhases({
        repoRoot: args.repoRoot,
        record,
        token,
      })
      return { ok: true }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      log.error("chain-integration failed", { detail })
      await markFailed(record, detail, token)
      return { ok: false, detail }
    }
  } finally {
    worker.release()
  }
}

async function runPhases(args: Readonly<{
  repoRoot: string
  record: ChainIntegrationRecord
  token: string | undefined
}>): Promise<void> {
  const config = loadConfig()
  const ci = config.chat.discord.chain_integration
  const layout = chainIntegrationLayout()
  const artDir = integrationArtifactDir(layout, args.record.integrationId)
  mkdirSync(artDir, { recursive: true, mode: 0o700 })

  let record = args.record
  const source = record.sources[0]!
  const tokenAddress = source.tokenAddress

  const setPhase = async (
    phase: ChainIntegrationPhase,
    patch: Partial<ChainIntegrationRecord> = {},
  ) => {
    record = await updateRecord(record.integrationId, { phase, ...patch })
    await appendJournalLine(layout, record.integrationId, { event: "phase", phase })
  }

  // --- collecting ---
  if (
    record.phase === "queued"
    || record.phase === "collecting"
  ) {
    await setPhase("collecting")
    let evidence
    let attempt = record.providerAttempts
    let lastErr = "provider evidence failed"
    while (attempt < ci.provider_max_attempts) {
      attempt += 1
      record = await updateRecord(record.integrationId, { providerAttempts: attempt })
      try {
        evidence = await collectChainEvidence({
          layout,
          integrationId: record.integrationId,
          slug: record.slug,
          tokenAddress,
        })
        if (evidence.dexOk && evidence.geckoOk) break
        lastErr = "missing DexScreener/Gecko live coverage"
      } catch (error) {
        lastErr = error instanceof Error ? error.message : "evidence fetch failed"
      }
      const backoff = Math.min(60_000, 1_000 * (2 ** (attempt - 1)))
      await appendJournalLine(layout, record.integrationId, {
        event: "provider-retry",
        attempt,
        lastErr,
        backoff,
      })
      await sleep(backoff)
    }
    if (!evidence || !evidence.dexOk || !evidence.geckoOk) {
      throw new Error(lastErr)
    }

    const probe = await probeCursorCli()
    if (!probe.ok) throw new Error(`cursor cli unavailable: ${probe.detail}`)

    await writeAtomicFileFsync(
      join(artDir, "evidence-summary.json"),
      `${JSON.stringify({
        dexOk: evidence.dexOk,
        geckoOk: evidence.geckoOk,
        goplusSupported: evidence.goplusSupported,
        goplusChainId: evidence.goplusChainId,
        samplePair: evidence.samplePair,
      }, null, 2)}\n`,
      0o600,
    )

    const research = await runChainResearchAgent({
      repoRoot: args.repoRoot,
      evidenceIndexPath: join(artDir, "evidence", "index.json"),
      slug: record.slug,
      tokenAddress,
      model: ci.research_model,
    })
    if (!research.ok) throw new Error(research.reason)

    const validated = validateResearchProposal({
      proposal: research.proposal,
      expectedSlug: record.slug,
      tokenAddress,
      dexOk: evidence.dexOk,
      geckoOk: evidence.geckoOk,
      goplusSupported: evidence.goplusSupported,
      ...(evidence.goplusChainId ? { goplusChainId: evidence.goplusChainId } : {}),
      ...(evidence.samplePair ? { samplePairChainId: evidence.samplePair.chainId } : {}),
    })
    if (!validated.ok) throw new Error(validated.reason)

    const manifestText = `${JSON.stringify(research.proposal.manifest, null, 2)}\n`
    const manifestPath = join(artDir, "validated-manifest.json")
    await writeAtomicFileFsync(manifestPath, manifestText, 0o600)
    await writeAtomicFileFsync(
      join(artDir, "research-proposal.json"),
      `${JSON.stringify(research.proposal, null, 2)}\n`,
      0o600,
    )

    await setPhase("researched", {
      displayName: research.proposal.manifest.display,
      manifestHash: sha256Bytes(Buffer.from(manifestText)),
    })
  }

  // --- prepared (worktree) ---
  if (record.phase === "researched" || record.phase === "prepared") {
    assertCleanMain(args.repoRoot)
    const remote = fetchOriginMain(args.repoRoot)
    const local = assertCleanMain(args.repoRoot)
    if (local !== remote) {
      // Fast-forward local main to origin before basing worktree
      const { spawnSync } = await import("node:child_process")
      const ff = spawnSync("git", ["merge", "--ff-only", "origin/main"], {
        cwd: args.repoRoot,
        encoding: "utf8",
      })
      if ((ff.status ?? 1) !== 0) {
        throw new Error("cannot fast-forward main to origin/main")
      }
    }
    const baseSha = assertCleanMain(args.repoRoot)
    const { worktreePath, branch } = prepareWorktree({
      repoRoot: args.repoRoot,
      integrationId: record.integrationId,
      baseSha,
    })
    await setPhase("prepared", {
      baseCommit: baseSha,
      worktreePath,
      branch,
    })
  }

  // --- building / finalizing with repair rounds ---
  const manifestPath = join(artDir, "validated-manifest.json")
  const { readValidatedManifest } = await import("./agents.js")
  const validatedManifest = readValidatedManifest(manifestPath)

  while (
    record.phase === "prepared"
    || record.phase === "building"
    || record.phase === "finalizing"
  ) {
    if (!record.worktreePath) throw new Error("worktree missing")
    await setPhase("building")
    const build = await runChainBuildAgent({
      worktreePath: record.worktreePath,
      manifestPath,
      slug: record.slug,
      model: ci.build_model,
    })
    if (!build.ok) throw new Error(build.reason)

    const buildGate = evaluateBuildConfinement({
      worktreePath: record.worktreePath,
      slug: record.slug,
      baselineManifestSlugs: listRepoChainSlugs(args.repoRoot),
      validatedManifest,
    })
    if (!buildGate.ok) {
      if (record.repairRound >= ci.repair_max_rounds) {
        throw new Error(`build confinement: ${buildGate.violations.join(",")}`)
      }
      record = await updateRecord(record.integrationId, {
        repairRound: record.repairRound + 1,
      })
      continue
    }

    await setPhase("finalizing")
    const testPath = join(
      record.worktreePath,
      "tests",
      "unit",
      "chains",
      `${record.slug}.test.ts`,
    )
    const finalize = await runChainFinalizeAgent({
      worktreePath: record.worktreePath,
      manifestPath,
      testPath,
      model: ci.finalize_model,
    })
    if (!finalize.ok) throw new Error(finalize.reason)

    const reviewOk = validateFinalReview(finalize.review)
    const finGate = evaluateFinalizeConfinement({
      worktreePath: record.worktreePath,
      slug: record.slug,
      afterBuildChanged: buildGate.changed,
    })
    if (!reviewOk.ok || !finGate.ok) {
      if (record.repairRound >= ci.repair_max_rounds) {
        throw new Error(
          reviewOk.ok
            ? `finalize confinement: ${finGate.violations.join(",")}`
            : reviewOk.reason,
        )
      }
      record = await updateRecord(record.integrationId, {
        repairRound: record.repairRound + 1,
      })
      continue
    }

    await writeAtomicFileFsync(
      join(artDir, "final-review.json"),
      `${JSON.stringify(finalize.review, null, 2)}\n`,
      0o600,
    )
    break
  }

  // --- gated ---
  if (
    record.phase === "finalizing"
    || record.phase === "building"
    || record.phase === "gated"
    || record.phase === "prepared"
  ) {
    if (!record.worktreePath) throw new Error("worktree missing")
    const gate = await runCleanGate({
      worktreePath: record.worktreePath,
      artifactDir: artDir,
    })
    if (!gate.ok) {
      throw new Error(
        `clean gate failed: ${gate.steps.filter((s) => !s.ok).map((s) => s.name).join(",")}`,
      )
    }
    await setPhase("gated", { gateHash: gate.hash })
  }

  // --- commit ---
  if (record.phase === "gated" || record.phase === "committed") {
    if (!record.worktreePath) throw new Error("worktree missing")
    const sha = commitIntegration({
      worktreePath: record.worktreePath,
      slug: record.slug,
      display: record.displayName ?? validatedManifest.display,
    })
    await setPhase("committed", { candidateCommit: sha })
  }

  // --- push (with one base-rebuild) ---
  if (record.phase === "committed" || record.phase === "pushed") {
    if (!record.worktreePath || !record.branch || !record.baseCommit || !record.candidateCommit) {
      throw new Error("publish state incomplete")
    }
    try {
      pushAndFastForward({
        repoRoot: args.repoRoot,
        worktreePath: record.worktreePath,
        branch: record.branch,
        baseSha: record.baseCommit,
        candidateSha: record.candidateCommit,
      })
    } catch (error) {
      if (error instanceof PublishError
        && (error.code === "main-moved" || error.code === "origin-moved")
      ) {
        // One rebuild from new base
        const remote = fetchOriginMain(args.repoRoot)
        const { spawnSync } = await import("node:child_process")
        spawnSync("git", ["merge", "--ff-only", remote], {
          cwd: args.repoRoot,
          encoding: "utf8",
        })
        const baseSha = assertCleanMain(args.repoRoot)
        const prep = prepareWorktree({
          repoRoot: args.repoRoot,
          integrationId: `${record.integrationId}-r1`,
          baseSha,
        })
        record = await updateRecord(record.integrationId, {
          baseCommit: baseSha,
          worktreePath: prep.worktreePath,
          branch: prep.branch,
          repairRound: record.repairRound,
          phase: "prepared",
          candidateCommit: undefined,
        })
        throw new Error("base moved — operator retry required after rebuild")
      }
      throw error
    }
    await setPhase("pushed")
  }

  // --- deploy ---
  if (record.phase === "pushed" || record.phase === "deploying" || record.phase === "deployed") {
    if (!record.candidateCommit) throw new Error("candidate commit missing")
    const candidateSha = record.candidateCommit
    await setPhase("deploying")
    const archiveRoot = join(homedir(), ".trenchcoat", "archive")
    let deployAttempts = record.deployAttempts
    let lastDetail = "deploy failed"
    let deployed = false
    while (deployAttempts < ci.deploy_max_attempts) {
      deployAttempts += 1
      record = await updateRecord(record.integrationId, { deployAttempts })
      const result = await deployIntegration({
        repoRoot: args.repoRoot,
        archiveRoot,
        sourceCommit: candidateSha,
        integrationId: record.integrationId,
      })
      if (result.ok) {
        deployed = true
        break
      }
      lastDetail = result.detail ?? "deploy failed"
    }
    if (!deployed) {
      if (record.baseCommit) {
        revertAndRedeploy({
          repoRoot: args.repoRoot,
          candidateSha,
          baseSha: record.baseCommit,
        })
      }
      throw new Error(lastDetail)
    }
    const health = verifyPostDeployHealth({
      candidateSha,
      slug: record.slug,
    })
    if (!health.ok) {
      if (record.baseCommit) {
        revertAndRedeploy({
          repoRoot: args.repoRoot,
          candidateSha,
          baseSha: record.baseCommit,
        })
      }
      throw new Error(health.reason)
    }
    await setPhase("deployed")
  }

  // --- announce + research handoff via newly deployed CLI ---
  if (
    record.phase === "deployed"
    || record.phase === "announced"
    || record.phase === "research_queued"
  ) {
    const runtimeCli = join(homedir(), ".trenchcoat", "runtime", "dist", "cli.js")
    const { spawnSync } = await import("node:child_process")
    if (existsSync(runtimeCli)) {
      const cont = spawnSync(
        process.execPath,
        [runtimeCli, "discord", "chains", "continue", record.integrationId],
        {
          encoding: "utf8",
          timeout: 10 * 60_000,
          env: process.env,
          cwd: args.repoRoot,
        },
      )
      if ((cont.status ?? 1) !== 0) {
        throw new Error(
          `post-deploy continue failed: ${(cont.stderr || cont.stdout).slice(0, 400)}`,
        )
      }
      return
    }
    // Dev fallback when runtime not installed
    if (!args.token) throw new Error("DISCORD_RESEARCH_BOT_TOKEN required for announce")
    const display = record.displayName ?? validatedManifest.display
    if (record.phase === "deployed") {
      await announceIntegrationSuccess({
        integration: record,
        displayName: display,
        token: args.token,
      })
      record = (await createChainIntegrationStore(layout).findById(record.integrationId))!
    }
    if (record.phase === "announced" || record.phase === "research_queued") {
      await handoffToResearchFifo({
        integration: record,
        canonicalSlug: record.slug,
        repoRoot: args.repoRoot,
        token: args.token,
      })
    }
  }
}

export async function continueAfterDeploy(args: Readonly<{
  integrationId: string
  repoRoot: string
  token?: string
}>): Promise<{ ok: boolean; detail?: string }> {
  const token = args.token ?? resolveDiscordBotToken()
  if (!token) return { ok: false, detail: "DISCORD_RESEARCH_BOT_TOKEN required" }
  const layout = chainIntegrationLayout()
  const store = createChainIntegrationStore(layout)
  const record = store.findById(args.integrationId)
  if (!record) return { ok: false, detail: "integration not found" }
  if (record.phase === "completed") return { ok: true, detail: "already completed" }
  if (
    record.phase !== "deployed"
    && record.phase !== "announced"
    && record.phase !== "research_queued"
  ) {
    return { ok: false, detail: `phase ${record.phase} not ready for continue` }
  }

  const display = record.displayName ?? record.slug
  let current = record
  if (current.phase === "deployed") {
    await announceIntegrationSuccess({
      integration: current,
      displayName: display,
      token,
    })
    current = store.findById(args.integrationId)!
  }
  if (current.phase === "announced" || current.phase === "research_queued") {
    await handoffToResearchFifo({
      integration: current,
      canonicalSlug: current.slug,
      repoRoot: args.repoRoot,
      token,
    })
  }
  return { ok: true }
}

export function loadChainIntegrationStatus(): Readonly<{
  enabled: boolean
  activeIntegrationId: string | null
  phase?: string
  slug?: string
  baseCommit?: string
  candidateCommit?: string
  attemptsToday: number
  maxAttempts: number
  lastFailure?: string
  queued: number
}> {
  const config = loadConfig()
  const ci = config.chat.discord.chain_integration
  const store = createChainIntegrationStore(chainIntegrationLayout())
  const file = store.load()
  const day = systemClock.nowIso().slice(0, 10)
  const active = file.activeIntegrationId
    ? file.integrations.find((i) => i.integrationId === file.activeIntegrationId)
    : undefined
  const lastFailure = [...file.integrations]
    .reverse()
    .find((i) => i.phase === "failed")
  return {
    enabled: ci.enabled,
    activeIntegrationId: file.activeIntegrationId,
    ...(active?.phase ? { phase: active.phase } : {}),
    ...(active?.slug ? { slug: active.slug } : {}),
    ...(active?.baseCommit ? { baseCommit: active.baseCommit } : {}),
    ...(active?.candidateCommit ? { candidateCommit: active.candidateCommit } : {}),
    attemptsToday: file.attemptsByDay[day] ?? 0,
    maxAttempts: ci.max_attempts_per_utc_day,
    ...(lastFailure?.terminalError ? { lastFailure: lastFailure.terminalError } : {}),
    queued: file.integrations.filter((i) => i.phase === "queued").length,
  }
}

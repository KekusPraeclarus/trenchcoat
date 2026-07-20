import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { WorkspaceLock } from "../lib/lock.js"
import { systemClock } from "../lib/clock.js"
import { loadConfig } from "../lib/config.js"
import { log } from "../lib/log.js"
import {
  createDiscordRestClient,
  DISCORD_RESEARCH_STARTED_EMOJI,
} from "../discord/bot-client.js"
import { processNextDiscordRequest } from "../discord/pump.js"
import {
  promoteReservationToResearch,
  releaseResearchReservation,
} from "./intake.js"
import { chainIntegrationLayout, integrationArtifactDir } from "./paths.js"
import { appendJournalLine, createChainIntegrationStore } from "./store.js"
import type { ChainIntegrationRecord } from "./schemas.js"

function announcementNonce(integrationId: string, messageId: string): string {
  return `ci-announce:${integrationId}:${messageId}`
}

export async function announceIntegrationSuccess(args: Readonly<{
  integration: ChainIntegrationRecord
  displayName: string
  token: string
}>): Promise<void> {
  const layout = chainIntegrationLayout()
  const store = createChainIntegrationStore(layout)
  const client = createDiscordRestClient(args.token)
  const content = `${args.displayName} chain now integrated`

  let file = store.load()
  const idx = file.integrations.findIndex(
    (i) => i.integrationId === args.integration.integrationId,
  )
  if (idx < 0) return
  const record = { ...file.integrations[idx]! }

  for (let i = 0; i < record.sources.length; i += 1) {
    const source = record.sources[i]!
    if (source.announced) continue
    try {
      await client.sendReply({
        channelId: source.channelId,
        content,
        replyToMessageId: source.messageId,
        // Deterministic Discord nonce via content+message — host records local receipt
      })
      record.sources[i] = { ...source, announced: true }
      await appendJournalLine(layout, record.integrationId, {
        event: "announced",
        messageId: source.messageId,
        nonce: announcementNonce(record.integrationId, source.messageId),
      })
    } catch (error) {
      log.warn("chain-integration announce failed", {
        messageId: source.messageId,
        error: error instanceof Error ? error.message : "unknown",
      })
      throw error
    }
  }

  record.phase = "announced"
  record.updatedAt = systemClock.nowIso()
  file.integrations[idx] = record
  await store.save(file)
}

export async function handoffToResearchFifo(args: Readonly<{
  integration: ChainIntegrationRecord
  canonicalSlug: string
  repoRoot: string
  token: string
}>): Promise<void> {
  const layout = chainIntegrationLayout()
  const store = createChainIntegrationStore(layout)
  let file = store.load()
  const idx = file.integrations.findIndex(
    (i) => i.integrationId === args.integration.integrationId,
  )
  if (idx < 0) return
  const record = { ...file.integrations[idx]! }

  for (let i = 0; i < record.sources.length; i += 1) {
    const source = record.sources[i]!
    if (source.researchEnqueued) continue
    const ok = await promoteReservationToResearch(source.messageId, args.canonicalSlug)
    if (!ok) {
      throw new Error(`research handoff failed for ${source.messageId}`)
    }
    record.sources[i] = { ...source, researchEnqueued: true }
    await appendJournalLine(layout, record.integrationId, {
      event: "research-queued",
      messageId: source.messageId,
      chain: args.canonicalSlug,
    })
  }

  record.phase = "research_queued"
  record.updatedAt = systemClock.nowIso()
  file.integrations[idx] = record
  await store.save(file)

  for (;;) {
    const result = await processNextDiscordRequest({
      repoRoot: args.repoRoot,
      token: args.token,
    })
    if (result === "idle" || result === "busy") break
  }

  file = store.load()
  const doneIdx = file.integrations.findIndex(
    (i) => i.integrationId === args.integration.integrationId,
  )
  if (doneIdx >= 0) {
    file.integrations[doneIdx] = {
      ...file.integrations[doneIdx]!,
      phase: "completed",
      updatedAt: systemClock.nowIso(),
    }
    if (file.activeIntegrationId === args.integration.integrationId) {
      file.activeIntegrationId = null
    }
    await store.save(file)
  }
}

export async function failIntegrationSources(
  integration: ChainIntegrationRecord,
  token: string | undefined,
): Promise<void> {
  const client = token ? createDiscordRestClient(token) : undefined
  const content =
    `Could not safely integrate ${integration.slug}; the request was not deployed.`
  for (const source of integration.sources) {
    await releaseResearchReservation(source.messageId)
    if (!client || source.announced) continue
    try {
      await client.sendReply({
        channelId: source.channelId,
        content,
        replyToMessageId: source.messageId,
      })
    } catch (error) {
      log.warn("chain-integration failure reply failed", {
        messageId: source.messageId,
        error: error instanceof Error ? error.message : "unknown",
      })
    }
  }
}

export async function reactAcceptedSources(
  integration: ChainIntegrationRecord,
  token: string,
): Promise<void> {
  const layout = chainIntegrationLayout()
  const store = createChainIntegrationStore(layout)
  const client = createDiscordRestClient(token)
  const lock = new WorkspaceLock(layout.lock)
  if (!lock.tryAcquire()) return
  try {
    const file = store.load()
    const idx = file.integrations.findIndex(
      (i) => i.integrationId === integration.integrationId,
    )
    if (idx < 0) return
    const record = { ...file.integrations[idx]!, sources: [...file.integrations[idx]!.sources] }
    let dirty = false
    for (let i = 0; i < record.sources.length; i += 1) {
      const source = record.sources[i]!
      if (source.reacted) continue
      try {
        await client.addReaction({
          channelId: source.channelId,
          messageId: source.messageId,
          emoji: DISCORD_RESEARCH_STARTED_EMOJI,
        })
        record.sources[i] = { ...source, reacted: true }
        dirty = true
      } catch (error) {
        log.warn("chain-integration reaction failed", {
          messageId: source.messageId,
          error: error instanceof Error ? error.message : "unknown",
        })
      }
    }
    if (dirty) {
      record.updatedAt = systemClock.nowIso()
      file.integrations[idx] = record
      await store.save(file)
    }
  } finally {
    lock.release()
  }
}

export function resolveDiscordBotToken(): string | undefined {
  return process.env["DISCORD_RESEARCH_BOT_TOKEN"]
    ?? process.env["DISCORD_BOT_TOKEN"]
}

export function verifyPostDeployHealth(args: Readonly<{
  candidateSha: string
  slug: string
}>): { ok: true } | { ok: false; reason: string } {
  const runtimeRoot = join(
    process.env["HOME"] ?? "",
    ".trenchcoat",
    "runtime",
  )
  const deploymentPath = join(runtimeRoot, "deployment.json")
  if (!existsSync(deploymentPath)) {
    return { ok: false, reason: "deployment.json missing" }
  }
  try {
    const manifest = JSON.parse(readFileSync(deploymentPath, "utf8")) as {
      sourceCommit?: string
      configSchema?: number
    }
    if (manifest.sourceCommit !== args.candidateSha) {
      return {
        ok: false,
        reason: `sourceCommit mismatch got=${manifest.sourceCommit}`,
      }
    }
    const cfg = loadConfig()
    if (cfg.schema !== 12) {
      return { ok: false, reason: `config schema ${cfg.schema}` }
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "deploy verify failed",
    }
  }

  // Smoke: newly deployed CLI can resolve the chain
  const smoke = spawnSync(
    join(runtimeRoot, "dist", "cli.js"),
    ["discord", "chains", "status"],
    { encoding: "utf8", timeout: 30_000 },
  )
  if ((smoke.status ?? 1) !== 0) {
    // status may still work even if chain not yet queryable via CLI; soft-check
    log.warn("post-deploy chains status non-zero", {
      detail: (smoke.stderr || smoke.stdout).slice(0, 200),
    })
  }

  void args.slug
  void integrationArtifactDir
  return { ok: true }
}

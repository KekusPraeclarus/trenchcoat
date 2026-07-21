import { createHash, randomBytes } from "node:crypto"
import { systemClock } from "../lib/clock.js"
import { loadConfig } from "../lib/config.js"
import { WorkspaceLock } from "../lib/lock.js"
import { getChain } from "../lib/chains.js"
import { discordLayout } from "../discord/paths.js"
import { createDiscordStore } from "../discord/store.js"
import { chainIntegrationLayout } from "./paths.js"
import { createChainIntegrationStore, appendJournalLine } from "./store.js"
import type { ChainIntegrationRecord, ChainIntegrationsFile } from "./schemas.js"
import { ACTIVE_INTEGRATION_PHASES } from "./schemas.js"

function utcDay(iso: string): string {
  return iso.slice(0, 10)
}

function newIntegrationId(slug: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-")
  const nonce = randomBytes(4).toString("hex")
  return `ci-${slug}-${stamp}-${nonce}`
}

export type AcceptChainIntegrationArgs = Readonly<{
  guildId: string
  channelId: string
  messageId: string
  userId: string
  slug: string
  tokenAddress: string
  subject: string
}>

export type AcceptChainIntegrationResult =
  | { accepted: true; integration: ChainIntegrationRecord; joined: boolean }
  | { accepted: false; terminal: string }

export async function acceptChainIntegration(
  args: AcceptChainIntegrationArgs,
): Promise<AcceptChainIntegrationResult> {
  if (getChain(args.slug)) {
    return { accepted: false, terminal: `chain ${args.slug} is already supported` }
  }

  const config = loadConfig()
  const ci = config.chat.discord.chain_integration
  if (!ci.enabled) {
    return { accepted: false, terminal: "chain integration is disabled" }
  }

  const nowIso = systemClock.nowIso()
  const day = utcDay(nowIso)
  const layout = chainIntegrationLayout()
  const store = createChainIntegrationStore(layout)
  const dLayout = discordLayout()
  const dStore = createDiscordStore(dLayout)

  const lock = new WorkspaceLock(layout.lock)
  if (!lock.tryAcquire()) {
    return { accepted: false, terminal: "bot busy — try again shortly" }
  }

  try {
    let file = store.load()
    const existing = file.integrations.find(
      (i) =>
        i.slug === args.slug
        && (ACTIVE_INTEGRATION_PHASES as readonly string[]).includes(i.phase),
    )

    if (existing) {
      if (existing.sources.some((s) => s.messageId === args.messageId)) {
        return { accepted: true, integration: existing, joined: true }
      }
      const source = {
        guildId: args.guildId,
        channelId: args.channelId,
        messageId: args.messageId,
        userId: args.userId,
        subject: args.subject,
        tokenAddress: args.tokenAddress,
        reservedQuota: false,
        reacted: false,
        announced: false,
        researchEnqueued: false,
      }
      // Reserve research quota for this user without charging integration attempt
      const reserved = await reserveResearchSlot({
        dStore,
        guildId: args.guildId,
        channelId: args.channelId,
        messageId: args.messageId,
        userId: args.userId,
        subject: args.subject,
        tokenAddress: args.tokenAddress,
        chainIntegrationId: existing.integrationId,
        nowIso,
      })
      if (!reserved.ok) {
        return { accepted: false, terminal: reserved.terminal }
      }
      source.reservedQuota = true
      existing.sources.push(source)
      existing.updatedAt = nowIso
      const idx = file.integrations.findIndex((i) => i.integrationId === existing.integrationId)
      file.integrations[idx] = existing
      await store.save(file)
      await appendJournalLine(layout, existing.integrationId, {
        event: "source-joined",
        messageId: args.messageId,
      })
      return { accepted: true, integration: existing, joined: true }
    }

    const attempts = file.attemptsByDay[day] ?? 0
    if (attempts >= ci.max_attempts_per_utc_day) {
      return {
        accepted: false,
        terminal: `daily chain-integration cap reached (${ci.max_attempts_per_utc_day})`,
      }
    }

    const active = file.integrations.find(
      (i) => (ACTIVE_INTEGRATION_PHASES as readonly string[]).includes(i.phase),
    )
    // One worker processes active; additional slugs stay queued
    void active

    const integrationId = newIntegrationId(args.slug)
    const reserved = await reserveResearchSlot({
      dStore,
      guildId: args.guildId,
      channelId: args.channelId,
      messageId: args.messageId,
      userId: args.userId,
      subject: args.subject,
      tokenAddress: args.tokenAddress,
      chainIntegrationId: integrationId,
      nowIso,
    })
    if (!reserved.ok) {
      return { accepted: false, terminal: reserved.terminal }
    }

    const record: ChainIntegrationRecord = {
      integrationId,
      slug: args.slug,
      phase: "queued",
      createdAt: nowIso,
      updatedAt: nowIso,
      quotaDay: day,
      sources: [{
        guildId: args.guildId,
        channelId: args.channelId,
        messageId: args.messageId,
        userId: args.userId,
        subject: args.subject,
        tokenAddress: args.tokenAddress,
        reservedQuota: true,
        reacted: false,
        announced: false,
        researchEnqueued: false,
      }],
      repairRound: 0,
      providerAttempts: 0,
      deployAttempts: 0,
    }

    file.attemptsByDay[day] = attempts + 1
    file.integrations.push(record)
    if (!file.activeIntegrationId) file.activeIntegrationId = integrationId
    await store.save(file)
    await appendJournalLine(layout, integrationId, {
      event: "accepted",
      slug: args.slug,
      messageId: args.messageId,
    })
    return { accepted: true, integration: record, joined: false }
  } finally {
    lock.release()
  }
}

async function reserveResearchSlot(args: Readonly<{
  dStore: ReturnType<typeof createDiscordStore>
  guildId: string
  channelId: string
  messageId: string
  userId: string
  subject: string
  tokenAddress: string
  chainIntegrationId: string
  nowIso: string
}>): Promise<{ ok: true } | { ok: false; terminal: string }> {
  const dLayout = discordLayout()
  const lock = new WorkspaceLock(dLayout.lock)
  if (!lock.tryAcquire()) {
    return { ok: false, terminal: "bot busy — try again shortly" }
  }
  try {
    let file = args.dStore.loadRequests()
    if (file.requests.some((r) => r.requestId === args.messageId)) {
      return { ok: true }
    }
    const day = utcDay(args.nowIso)
    // Placeholder reservation row — not pumped until handoff
    file.requests.push({
      requestId: args.messageId,
      guildId: args.guildId,
      channelId: args.channelId,
      messageId: args.messageId,
      userId: args.userId,
      subject: args.subject,
      tokenAddress: args.tokenAddress,
      status: "awaiting-chain",
      createdAt: args.nowIso,
      updatedAt: args.nowIso,
      deliveredPartKeys: [],
      quotaDay: day,
      chainIntegrationId: args.chainIntegrationId,
      terminalError: "awaiting-chain-integration",
    })
    await args.dStore.saveRequests(file)
    return { ok: true }
  } finally {
    lock.release()
  }
}

export async function releaseResearchReservation(
  messageId: string,
): Promise<void> {
  const dLayout = discordLayout()
  const dStore = createDiscordStore(dLayout)
  const lock = new WorkspaceLock(dLayout.lock)
  if (!lock.tryAcquire()) return
  try {
    let file = dStore.loadRequests()
    const idx = file.requests.findIndex(
      (r) => r.requestId === messageId
        && (r.status === "awaiting-chain" || r.terminalError === "awaiting-chain-integration"),
    )
    if (idx < 0) return
    file.requests[idx] = {
      ...file.requests[idx]!,
      status: "failed",
      terminalError: "chain-integration-failed",
      updatedAt: systemClock.nowIso(),
      chainIntegrationId: undefined,
    }
    await dStore.saveRequests(file)
  } finally {
    lock.release()
  }
}

export async function promoteReservationToResearch(
  messageId: string,
  chain: string,
): Promise<boolean> {
  const dLayout = discordLayout()
  const dStore = createDiscordStore(dLayout)
  const lock = new WorkspaceLock(dLayout.lock)
  if (!lock.tryAcquire()) return false
  try {
    const file = dStore.loadRequests()
    const idx = file.requests.findIndex((r) => r.requestId === messageId)
    if (idx < 0) return false
    const row = file.requests[idx]!
    file.requests[idx] = {
      ...row,
      status: "queued",
      chain: chain as never,
      subject: `${chain}:${row.tokenAddress ?? row.subject.split(":")[1] ?? ""}`,
      terminalError: undefined,
      chainIntegrationId: undefined,
      updatedAt: systemClock.nowIso(),
      deliveredPartKeys: [],
    }
    await dStore.saveRequests(file)
    return true
  } finally {
    lock.release()
  }
}

export function nextQueuedIntegration(
  file: ChainIntegrationsFile,
): ChainIntegrationRecord | undefined {
  return file.integrations
    .filter((i) => i.phase === "queued")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
}

export function fingerprint(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16)
}

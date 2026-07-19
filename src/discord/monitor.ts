import { loadConfig } from "../lib/config.js"
import { systemClock } from "../lib/clock.js"
import { WorkspaceLock } from "../lib/lock.js"
import { discordLayout } from "./paths.js"
import { createDiscordStore } from "./store.js"
import { pruneExpiredWatchlist } from "./watchlist.js"
import { tokenKey } from "./schemas.js"
import { detectMaterialChanges } from "./materiality.js"
import { createDiscordRestClient } from "./bot-client.js"
import { chunkDiscordReply } from "./render.js"
import {
  newestAnchorSubscription,
  otherSubscriberIds,
} from "./watchlist.js"
import type { CanonicalIdentity } from "../contracts/schemas.js"
import { collectWatchObservation } from "./collect-observation.js"
import { ensureDiscordAgentWorkspace } from "./agent-setup.js"
import { resolveDiscordRepoRoot } from "./listener.js"
import { runWatchUpdateWriter } from "./watch-update-session.js"

export async function runDiscordWatchlistScan(args: Readonly<{
  token: string
  repoRoot?: string
}>): Promise<void> {
  const config = loadConfig()
  if (!config.chat.discord.enabled) return

  const layout = discordLayout()
  const store = createDiscordStore(layout)
  const repoRoot = args.repoRoot ?? resolveDiscordRepoRoot()
  const agentRoot = ensureDiscordAgentWorkspace(repoRoot, layout)
  // Worker lock excludes research; store `.lock` stays free for Discord intake
  const worker = new WorkspaceLock(layout.workerLock)
  if (!worker.tryAcquire()) return

  const nowIso = systemClock.nowIso()
  try {
    let watch = pruneExpiredWatchlist(store.loadWatchlist(), nowIso)
    await store.saveWatchlist(watch)

    let cursor = store.loadMonitorCursor()
    const scanStartedAt = cursor?.scanStartedAt ?? nowIso
    let tokenIndex = cursor?.tokenIndex ?? 0

    if (tokenIndex >= watch.tokens.length) {
      await store.saveMonitorCursor(null)
      await store.writeHeartbeat("monitor", {
        schema: 1,
        pid: process.pid,
        updatedAt: nowIso,
      })
      return
    }

    const client = createDiscordRestClient(args.token)
    const obsFile = store.loadObservations()

    for (; tokenIndex < watch.tokens.length; tokenIndex += 1) {
      const token = watch.tokens[tokenIndex]!
      const key = tokenKey(token.chain, token.tokenAddress)
      const baseline = obsFile.byToken[key]
      if (!baseline) {
        await store.saveMonitorCursor({ schema: 1, scanStartedAt, tokenIndex: tokenIndex + 1 })
        continue
      }

      const identity: CanonicalIdentity = {
        chain: token.chain,
        tokenAddress: token.tokenAddress,
        pairAddress: token.tokenAddress,
        symbolDisplay: token.symbolDisplay ?? token.tokenAddress.slice(0, 8),
        resolution: "resolved",
      }
      const current = await collectWatchObservation({ identity, fetchedAt: nowIso })
      const changes = detectMaterialChanges(baseline, current)
      if (changes.length === 0) {
        await store.saveMonitorCursor({ schema: 1, scanStartedAt, tokenIndex: tokenIndex + 1 })
        continue
      }

      const anchor = newestAnchorSubscription(token, nowIso)
      if (!anchor) {
        await store.saveMonitorCursor({ schema: 1, scanStartedAt, tokenIndex: tokenIndex + 1 })
        continue
      }

      const written = await runWatchUpdateWriter({
        chain: token.chain,
        tokenAddress: token.tokenAddress,
        ...(token.symbolDisplay ? { symbolDisplay: token.symbolDisplay } : {}),
        observedAt: current.observedAt,
        changes,
        ...(token.researchBrief ? { researchBrief: token.researchBrief } : {}),
        agentRoot,
      })
      const parts = chunkDiscordReply(written.text)
      const mentionIds = otherSubscriberIds(token, anchor, nowIso)

      let delivered = false
      try {
        for (const part of parts) {
          await client.sendReply({
            channelId: anchor.channelId,
            content: part,
            replyToMessageId: anchor.messageId,
            mentionUserIds: mentionIds,
          })
        }
        delivered = true
      } catch (error) {
        const err = error as Error & { unknownMessage?: boolean }
        if (err.unknownMessage) {
          try {
            for (const part of parts) {
              await client.sendChannelMessage({
                channelId: anchor.channelId,
                content: part,
                mentionUserIds: [anchor.userId, ...mentionIds].slice(0, 99),
              })
            }
            delivered = true
          } catch {
            delivered = false
          }
        }
      }

      if (delivered) {
        obsFile.byToken[key] = current
        await store.saveObservations(obsFile)
        watch = store.loadWatchlist()
        const idx = watch.tokens.findIndex((t) => tokenKey(t.chain, t.tokenAddress) === key)
        if (idx >= 0) {
          watch.tokens[idx] = { ...watch.tokens[idx]!, lastNotifiedAt: nowIso }
          await store.saveWatchlist(watch)
        }
      }

      await store.saveMonitorCursor({ schema: 1, scanStartedAt, tokenIndex: tokenIndex + 1 })
    }

    await store.saveMonitorCursor(null)
    await store.writeHeartbeat("monitor", {
      schema: 1,
      pid: process.pid,
      updatedAt: systemClock.nowIso(),
    })
  } finally {
    worker.release()
  }
}

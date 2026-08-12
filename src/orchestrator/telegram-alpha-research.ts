/**
 * Host bridge: seal telegram-alpha messages → research queue (ADR 015).
 * Allowlisted alpha channels enqueue on a single message (verbatim CA or
 * ticker+hint resolution). Fail-closed; never invents CAs or broadcast text.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ResearchQueueEntrySchema,
  SnapshotEnvelopeSchema,
  type CanonicalIdentity,
  type ResearchQueueEntry,
} from "../contracts/schemas.js"
import { runArchiveDir, writeJsonRecordFsync, type ArchiveLayout } from "../lib/archive.js"
import { getChain } from "../lib/chains.js"
import { loadConfig } from "../lib/config.js"
import { enqueueResearch, dedupeKeyFor } from "../lib/research-queue.js"
import { StateStore } from "../lib/state.js"
import type { FetchLike } from "../collectors/market/geckoterminal.js"
import { resolveResearchSubject } from "./research-collect.js"
import {
  DISAMBIG_CONFIDENCE_MIN,
  SHORTLIST_MAX,
  canSpendDisambiguation,
  disambiguateShortlist,
  disambiguationUserMessage,
  extractAddressesFromText,
  extractCashtags,
  extractChainHint,
  filterShortlistForDisambiguation,
  parseDisambiguationPick,
  type DisambiguationSessionRunner,
} from "./token-disambiguation.js"

export const TELEGRAM_ALPHA_RESEARCH_MAX_ENQUEUE = 3
export const TELEGRAM_ALPHA_DISAMBIG_CONFIDENCE_MIN = DISAMBIG_CONFIDENCE_MIN
export const TELEGRAM_ALPHA_SHORTLIST_MAX = SHORTLIST_MAX
export const DEFAULT_TELEGRAM_ALPHA_DISAMBIG_MODEL = "composer-2.5-fast"

export type { DisambiguationSessionRunner }
export {
  extractAddressesFromText,
  extractCashtags,
  extractChainHint,
  filterShortlistForDisambiguation,
  parseDisambiguationPick,
  disambiguationUserMessage,
  canSpendDisambiguation,
  disambiguateShortlist,
}

export type TelegramAlphaResearchReceipt = Readonly<{
  schema: 1
  runId: string
  validatedAt: string
  accepted: readonly Readonly<{
    queueId: string
    chain: string
    tokenAddress: string
    path: "ca" | "ticker-resolved" | "ticker-model"
    symbolDisplay?: string
  }>[]
  rejected: readonly Readonly<{ reason: string; detail?: string }>[]
  parked: readonly Readonly<{
    reason: string
    subject: string
    shortlist?: readonly string[]
  }>[]
}>

type SealedTelegramItem = Readonly<{
  inboxRel: string
  provenance: string
  text: string
}>

function expiryIso(nowIso: string, days: number): string {
  return new Date(Date.parse(nowIso) + days * 86_400_000).toISOString()
}

function loadSealedTelegramItems(
  layout: ArchiveLayout,
  runId: string,
): readonly SealedTelegramItem[] {
  const inboxDir = join(runArchiveDir(layout, runId), "inbox")
  if (!existsSync(inboxDir)) return []
  const out: SealedTelegramItem[] = []
  for (const name of readdirSync(inboxDir)) {
    if (!name.startsWith("telegram-alpha-") || !name.endsWith(".json")) continue
    if (name === "telegram-alpha-manifest.json") continue
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(inboxDir, name), "utf8"))
    } catch {
      continue
    }
    const envelope = SnapshotEnvelopeSchema.safeParse(parsed)
    if (!envelope.success) continue
    for (const item of envelope.data.items) {
      if (!item.provenance.startsWith("telegram:")) continue
      if (item.text.trim().length < 1) continue
      out.push({
        inboxRel: `inbox/${runId}/${name}`,
        provenance: item.provenance,
        text: item.text,
      })
    }
  }
  return out
}

function utcDay(nowIso: string): string {
  return nowIso.slice(0, 10)
}

function loadDisambiguationDayCount(state: StateStore, nowIso: string): number {
  const file = state.loadSocialCashtagClusters()
  const today = utcDay(nowIso)
  if (!file.disambiguationsToday || file.disambiguationsToday.day !== today) return 0
  return file.disambiguationsToday.count
}

async function saveDisambiguationDayCount(
  state: StateStore,
  nowIso: string,
  count: number,
): Promise<void> {
  const file = state.loadSocialCashtagClusters()
  await state.saveSocialCashtagClusters({
    ...file,
    disambiguationsToday: { day: utcDay(nowIso), count },
  })
}

/**
 * Host-owned telegram-alpha → research enqueue. Cap 3 per run; skip dupes.
 */
export async function enqueueTelegramAlphaResearch(args: Readonly<{
  agentRoot: string
  layout: ArchiveLayout
  runId: string
  nowIso: string
  dryRun?: boolean
  fetcher?: FetchLike
  runDisambiguation?: DisambiguationSessionRunner
}>): Promise<TelegramAlphaResearchReceipt> {
  const config = loadConfig()
  const fetcher = args.fetcher ?? globalThis.fetch
  const sealed = loadSealedTelegramItems(args.layout, args.runId)
  const accepted: TelegramAlphaResearchReceipt["accepted"][number][] = []
  const rejected: TelegramAlphaResearchReceipt["rejected"][number][] = []
  const parked: TelegramAlphaResearchReceipt["parked"][number][] = []

  const receiptPath = join(
    runArchiveDir(args.layout, args.runId),
    "telegram-alpha-research-receipt.json",
  )

  if (sealed.length === 0) {
    const receipt: TelegramAlphaResearchReceipt = {
      schema: 1,
      runId: args.runId,
      validatedAt: args.nowIso,
      accepted: [],
      rejected: [{ reason: "no-sealed-telegram-items" }],
      parked: [],
    }
    await writeJsonRecordFsync(receiptPath, receipt as never)
    return receipt
  }

  const state = new StateStore(join(args.agentRoot, "state"))
  let queue = state.loadResearchQueue()
  const watchlist = state.loadWatchlist()
  const watchlistKeys = new Set(
    watchlist.entries.map((e) => `${e.identity.chain}:${e.identity.tokenAddress}`.toLowerCase()),
  )
  const queueKeys = new Set(queue.entries.map((e) => dedupeKeyFor(e)))
  let disambiguationDayCount = loadDisambiguationDayCount(state, args.nowIso)
  const disambiguationCap = config.research.disambiguation_daily_cap
  let disambiguationDirty = false

  const tryEnqueue = async (opts: Readonly<{
    identity: CanonicalIdentity
    path: "ca" | "ticker-resolved" | "ticker-model"
    evidenceRel: string
    reason: string
  }>): Promise<boolean> => {
    if (accepted.length >= TELEGRAM_ALPHA_RESEARCH_MAX_ENQUEUE) {
      rejected.push({ reason: "over-cap", detail: opts.identity.tokenAddress })
      return false
    }
    const key = `${opts.identity.chain}:${opts.identity.tokenAddress}`.toLowerCase()
    if (watchlistKeys.has(key)) {
      rejected.push({ reason: "duplicated-watchlist", detail: key })
      return false
    }
    if (queueKeys.has(key)) {
      rejected.push({ reason: "duplicated-queue", detail: key })
      return false
    }
    if (!getChain(opts.identity.chain)?.securityScanner) {
      rejected.push({ reason: "unsupported-chain", detail: opts.identity.chain })
      return false
    }
    const subject = `${opts.identity.chain}:${opts.identity.tokenAddress}`
    const queueId = `rq-tg-${args.runId}-${accepted.length + 1}`.slice(0, 128)
    const entry: ResearchQueueEntry = ResearchQueueEntrySchema.parse({
      schema: 1,
      queueId,
      subject,
      chain: opts.identity.chain,
      tokenAddress: opts.identity.tokenAddress,
      ...(opts.identity.pairAddress ? { pairAddress: opts.identity.pairAddress } : {}),
      ...(opts.identity.symbolDisplay ? { symbolDisplay: opts.identity.symbolDisplay } : {}),
      resolution: opts.path === "ticker-model" ? "model-confirmed" : "resolved",
      priority: 50,
      firstSeen: args.nowIso,
      enqueuedAt: args.nowIso,
      enqueuedBy: `telegram-alpha:${args.runId}`.slice(0, 128),
      trigger: "social",
      expiresAt: expiryIso(args.nowIso, config.research.queue_expiry_days),
      provenance: [
        `telegram-alpha:${args.runId}`,
        opts.evidenceRel,
      ].slice(0, 32),
      clusterCount: 1,
      security: { status: "pending", flags: [] },
      status: "pending",
      reason: opts.reason.slice(0, 280),
    })
    if (!args.dryRun) {
      queue = enqueueResearch(queue, entry, config.research.daily_cap)
    }
    queueKeys.add(key)
    accepted.push({
      queueId,
      chain: opts.identity.chain,
      tokenAddress: opts.identity.tokenAddress,
      path: opts.path,
      ...(opts.identity.symbolDisplay ? { symbolDisplay: opts.identity.symbolDisplay } : {}),
    })
    return true
  }

  const runPick = async (opts: Readonly<{
    shortlist: readonly CanonicalIdentity[]
    shillText: string
    ticker: string
    chainHint?: CanonicalIdentity["chain"]
  }>) => {
    const picked = await disambiguateShortlist({
      shortlist: opts.shortlist,
      shillText: opts.shillText,
      ticker: opts.ticker,
      ...(opts.chainHint ? { chainHint: opts.chainHint } : {}),
      fetcher,
      ...(args.runDisambiguation
        ? { runDisambiguation: args.runDisambiguation }
        : {}),
      disambiguationDayCount,
      disambiguationCap,
    })
    if (picked.spentDisambiguation) {
      disambiguationDayCount += 1
      disambiguationDirty = true
    }
    return picked
  }

  for (const item of sealed) {
    if (accepted.length >= TELEGRAM_ALPHA_RESEARCH_MAX_ENQUEUE) break

    const addresses = extractAddressesFromText(item.text)
    const chainHint = extractChainHint(item.text)

    for (const address of addresses) {
      if (accepted.length >= TELEGRAM_ALPHA_RESEARCH_MAX_ENQUEUE) break
      const subject = chainHint ? `${chainHint}:${address}` : address
      const resolved = await resolveResearchSubject(
        {
          subject,
          ...(chainHint ? { chainHint } : {}),
          tokenHint: address,
        },
        fetcher as typeof fetch,
      )
      if (resolved.status === "resolved") {
        await tryEnqueue({
          identity: resolved.identity,
          path: "ca",
          evidenceRel: item.inboxRel,
          reason: `telegram-alpha CA ${address}`,
        })
        continue
      }
      if (resolved.status === "ambiguous" && resolved.shortlist.length > 0) {
        const picked = await runPick({
          shortlist: resolved.shortlist,
          shillText: item.text,
          ticker: resolved.shortlist[0]?.symbolDisplay ?? "TOKEN",
          ...(chainHint ? { chainHint } : {}),
        })
        if (picked.ok) {
          await tryEnqueue({
            identity: {
              ...picked.identity,
              resolution: "model-confirmed",
              resolutionConfidence: picked.confidence,
            },
            path: "ticker-model",
            evidenceRel: item.inboxRel,
            reason: `telegram-alpha CA disambiguated ${address}`,
          })
        } else {
          parked.push({
            reason: picked.reason,
            subject,
            shortlist: resolved.shortlist.map((s) => `${s.chain}:${s.tokenAddress}`),
          })
          if (!args.dryRun) {
            queue = parkAmbiguous({
              queue,
              runId: args.runId,
              nowIso: args.nowIso,
              subject,
              evidenceRel: item.inboxRel,
              expiryDays: config.research.queue_expiry_days,
              reason: picked.reason,
              shortlist: resolved.shortlist,
              acceptedIndex: accepted.length + parked.length,
            })
          }
        }
        continue
      }
      rejected.push({
        reason: resolved.status === "unsupported-chain"
          ? "unsupported-chain"
          : "ca-unresolved",
        detail: address,
      })
    }

    // Ticker path only when no CA was extracted from this message
    if (addresses.length > 0) continue
    const tickers = extractCashtags(item.text)
    for (const ticker of tickers) {
      if (accepted.length >= TELEGRAM_ALPHA_RESEARCH_MAX_ENQUEUE) break
      const resolved = await resolveResearchSubject(
        {
          subject: ticker,
          ...(chainHint ? { chainHint } : {}),
          tokenHint: ticker,
        },
        fetcher as typeof fetch,
      )
      if (resolved.status === "resolved") {
        await tryEnqueue({
          identity: resolved.identity,
          path: "ticker-resolved",
          evidenceRel: item.inboxRel,
          reason: `telegram-alpha ticker $${ticker}`,
        })
        continue
      }
      if (resolved.status === "ambiguous" && resolved.shortlist.length > 0) {
        const picked = await runPick({
          shortlist: resolved.shortlist,
          shillText: item.text,
          ticker,
          ...(chainHint ? { chainHint } : {}),
        })
        if (picked.ok) {
          await tryEnqueue({
            identity: {
              ...picked.identity,
              resolution: "model-confirmed",
              resolutionConfidence: picked.confidence,
            },
            path: "ticker-model",
            evidenceRel: item.inboxRel,
            reason: `telegram-alpha ticker $${ticker} model-confirmed`,
          })
        } else {
          parked.push({
            reason: picked.reason,
            subject: ticker,
            shortlist: resolved.shortlist.map((s) => `${s.chain}:${s.tokenAddress}`),
          })
          if (!args.dryRun) {
            queue = parkAmbiguous({
              queue,
              runId: args.runId,
              nowIso: args.nowIso,
              subject: ticker,
              evidenceRel: item.inboxRel,
              expiryDays: config.research.queue_expiry_days,
              reason: picked.reason,
              shortlist: resolved.shortlist,
              acceptedIndex: accepted.length + parked.length,
            })
          }
        }
        continue
      }
      rejected.push({
        reason: resolved.status === "empty" ? "ticker-unresolved" : resolved.status,
        detail: ticker,
      })
    }
  }

  if (!args.dryRun && (accepted.length > 0 || parked.length > 0)) {
    await state.saveResearchQueue(queue)
  }
  if (!args.dryRun && disambiguationDirty) {
    await saveDisambiguationDayCount(state, args.nowIso, disambiguationDayCount)
  }

  const receipt: TelegramAlphaResearchReceipt = {
    schema: 1,
    runId: args.runId,
    validatedAt: args.nowIso,
    accepted,
    rejected,
    parked,
  }
  await writeJsonRecordFsync(receiptPath, receipt as never)
  return receipt
}

function parkAmbiguous(args: Readonly<{
  queue: ReturnType<StateStore["loadResearchQueue"]>
  runId: string
  nowIso: string
  subject: string
  evidenceRel: string
  expiryDays: number
  reason: string
  shortlist: readonly CanonicalIdentity[]
  acceptedIndex: number
}>): ReturnType<StateStore["loadResearchQueue"]> {
  const queueId = `rq-tg-amb-${args.runId}-${args.acceptedIndex}`.slice(0, 128)
  const entry: ResearchQueueEntry = ResearchQueueEntrySchema.parse({
    schema: 1,
    queueId,
    subject: args.subject.slice(0, 256),
    resolution: "ambiguous",
    priority: 50,
    firstSeen: args.nowIso,
    enqueuedAt: args.nowIso,
    enqueuedBy: `telegram-alpha:${args.runId}`.slice(0, 128),
    trigger: "social",
    expiresAt: expiryIso(args.nowIso, args.expiryDays),
    provenance: [
      `telegram-alpha:${args.runId}`,
      args.evidenceRel,
      ...args.shortlist.slice(0, 8).map((s) => `${s.chain}:${s.tokenAddress}`),
    ].slice(0, 32),
    clusterCount: 1,
    security: { status: "pending", flags: [] },
    status: "ambiguous",
    reason: args.reason.slice(0, 280),
  })
  return enqueueResearch(args.queue, entry, 10_000)
}

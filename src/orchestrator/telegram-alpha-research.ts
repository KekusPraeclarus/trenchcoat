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
import { isValidEvmAddress, isValidSolanaAddress, normalizeEvmAddress } from "../lib/address.js"
import { runArchiveDir, writeJsonRecordFsync, type ArchiveLayout } from "../lib/archive.js"
import { CHAIN_REGISTRY, getChain, type ChainEntry } from "../lib/chains.js"
import { loadConfig } from "../lib/config.js"
import { enqueueResearch, dedupeKeyFor } from "../lib/research-queue.js"
import { validateModelPick } from "../lib/resolve.js"
import { StateStore } from "../lib/state.js"
import { fetchSecurityGate } from "../collectors/market/security.js"
import type { FetchLike } from "../collectors/market/geckoterminal.js"
import { DISAMBIGUATION_PROMPT } from "../prompts/host.js"
import { resolveResearchSubject } from "./research-collect.js"

export const TELEGRAM_ALPHA_RESEARCH_MAX_ENQUEUE = 3
export const TELEGRAM_ALPHA_DISAMBIG_CONFIDENCE_MIN = 60
export const TELEGRAM_ALPHA_SHORTLIST_MAX = 5
export const DEFAULT_TELEGRAM_ALPHA_DISAMBIG_MODEL = "composer-2.5-fast"

export type DisambiguationSessionRunner = (
  args: Readonly<{ prompt: string; message: string }>,
) => Promise<string>

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

const EVM_RE = /\b(0x[a-fA-F0-9]{40})\b/gu
const CASHTAG_RE = /\$([A-Za-z][A-Za-z0-9]{1,15})\b/gu
/** Solana base58 — length-bounded to avoid matching ordinary words */
const SOL_RE = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/gu

export function extractAddressesFromText(text: string): readonly string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(EVM_RE)) {
    const raw = match[1]!
    if (!isValidEvmAddress(raw)) continue
    const normalized = normalizeEvmAddress(raw)
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  for (const match of text.matchAll(SOL_RE)) {
    const raw = match[1]!
    if (!isValidSolanaAddress(raw)) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    out.push(raw)
  }
  return out
}

export function extractCashtags(text: string): readonly string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(CASHTAG_RE)) {
    const ticker = match[1]!.toUpperCase()
    if (seen.has(ticker)) continue
    seen.add(ticker)
    out.push(ticker)
  }
  return out
}

/** Deterministic chain hint from shill text against CHAIN_REGISTRY. */
export function extractChainHint(text: string): CanonicalIdentity["chain"] | undefined {
  const lower = text.toLowerCase()
  const hits: ChainEntry[] = []
  for (const chain of CHAIN_REGISTRY) {
    const needles = [
      chain.slug,
      chain.display.toLowerCase(),
      `${chain.slug} chain`,
      `${chain.display.toLowerCase()} chain`,
    ]
    // Common shorthand
    if (chain.slug === "robinhood") {
      needles.push("rh chain", "rh eco", "robinhood eco")
    }
    if (chain.slug === "bsc") {
      needles.push("bnb chain", "binance smart chain")
    }
    if (chain.slug === "hyperliquid") {
      needles.push("hyperevm", "hl chain", "hyperliquid chain", "hyper evm")
    }
    if (chain.slug === "plasma") {
      needles.push("plasma chain", "xpl chain")
    }
    if (needles.some((n) => lower.includes(n))) hits.push(chain)
  }
  if (hits.length === 1) return hits[0]!.slug as CanonicalIdentity["chain"]
  return undefined
}

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

function stripFence(raw: string): string {
  let text = raw.trim()
  if (text.startsWith("```") && text.endsWith("```")) {
    text = text.replace(/^```(?:\w+)?\n?/u, "").replace(/\n?```$/u, "").trim()
  }
  return text
}

export function parseDisambiguationPick(
  raw: string,
): { ok: true; pick: string | null; confidence: number } | { ok: false; reason: string } {
  const text = stripFence(raw)
  if (text.length < 1) return { ok: false, reason: "empty" }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: "invalid-json" }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not-object" }
  }
  const record = parsed as Record<string, unknown>
  const pick = record["pick"]
  if (pick !== null && typeof pick !== "string") {
    return { ok: false, reason: "pick-invalid" }
  }
  if (typeof record["confidence"] !== "number" || !Number.isFinite(record["confidence"])) {
    return { ok: false, reason: "confidence-invalid" }
  }
  const confidence = Math.max(0, Math.min(100, Math.floor(record["confidence"])))
  return { ok: true, pick: pick === null ? null : pick, confidence }
}

export function filterShortlistForDisambiguation(args: Readonly<{
  shortlist: readonly CanonicalIdentity[]
  chainHint?: CanonicalIdentity["chain"]
  securityById: ReadonlyMap<string, { hardFail: boolean; status: string; flags: readonly string[] }>
}>): CanonicalIdentity[] {
  return args.shortlist
    .filter((id) => {
      if (args.chainHint && id.chain !== args.chainHint) return false
      const sec = args.securityById.get(`${id.chain}:${id.tokenAddress}`)
      if (sec?.hardFail) return false
      return true
    })
    .slice(0, TELEGRAM_ALPHA_SHORTLIST_MAX)
}

export function disambiguationUserMessage(args: Readonly<{
  shillText: string
  ticker: string
  chainHint?: CanonicalIdentity["chain"]
  candidates: readonly Readonly<{
    id: string
    chain: string
    tokenAddress: string
    symbolDisplay: string
    liquidityUsd?: number
    volume24hUsd?: number
    fdvUsd?: number | null
    securityStatus: string
    securityFlags: readonly string[]
  }>[]
}>): string {
  const lines = args.candidates.map((c) => (
    `- id=${c.id} chain=${c.chain} ca=${c.tokenAddress} symbol=${c.symbolDisplay}`
      + ` liqUsd=${c.liquidityUsd ?? "n/a"} vol24hUsd=${c.volume24hUsd ?? "n/a"}`
      + ` fdvUsd=${c.fdvUsd ?? "n/a"} security=${c.securityStatus}`
      + ` flags=${c.securityFlags.join(",") || "none"}`
  ))
  return [
    `Pick the best match for ticker $${args.ticker} given the untrusted shill text.`,
    `chainHint: ${args.chainHint ?? "(none)"}`,
    "Candidates (host-filtered):",
    ...lines,
    "<untrusted-shill>",
    args.shillText.slice(0, 4_000),
    "</untrusted-shill>",
  ].join("\n")
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
        const picked = await disambiguateShortlist({
          shortlist: resolved.shortlist,
          shillText: item.text,
          ticker: resolved.shortlist[0]?.symbolDisplay ?? "TOKEN",
          ...(chainHint ? { chainHint } : {}),
          fetcher,
          ...(args.runDisambiguation
            ? { runDisambiguation: args.runDisambiguation }
            : {}),
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
        const picked = await disambiguateShortlist({
          shortlist: resolved.shortlist,
          shillText: item.text,
          ticker,
          ...(chainHint ? { chainHint } : {}),
          fetcher,
          ...(args.runDisambiguation
            ? { runDisambiguation: args.runDisambiguation }
            : {}),
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

async function disambiguateShortlist(args: Readonly<{
  shortlist: readonly CanonicalIdentity[]
  shillText: string
  ticker: string
  chainHint?: CanonicalIdentity["chain"]
  fetcher: FetchLike
  runDisambiguation?: DisambiguationSessionRunner
}>): Promise<
  | { ok: true; identity: CanonicalIdentity; confidence: number }
  | { ok: false; reason: string }
> {
  const securityById = new Map<string, { hardFail: boolean; status: string; flags: readonly string[] }>()
  for (const id of args.shortlist.slice(0, TELEGRAM_ALPHA_SHORTLIST_MAX)) {
    const key = `${id.chain}:${id.tokenAddress}`
    try {
      const scan = await fetchSecurityGate(args.fetcher, id.chain, id.tokenAddress)
      securityById.set(key, {
        hardFail: scan.hardFail,
        status: scan.status,
        flags: scan.flags,
      })
    } catch {
      securityById.set(key, { hardFail: false, status: "pending", flags: [] })
    }
  }

  const filtered = filterShortlistForDisambiguation({
    shortlist: args.shortlist,
    ...(args.chainHint ? { chainHint: args.chainHint } : {}),
    securityById,
  })
  if (filtered.length === 0) {
    return { ok: false, reason: "shortlist-filtered-empty" }
  }
  if (filtered.length === 1) {
    return { ok: true, identity: filtered[0]!, confidence: 100 }
  }
  if (!args.runDisambiguation) {
    return { ok: false, reason: "no-disambiguation-runner" }
  }

  const candidates = filtered.map((id) => {
    const key = `${id.chain}:${id.tokenAddress}`
    const sec = securityById.get(key)
    return {
      id: key,
      chain: id.chain,
      tokenAddress: id.tokenAddress,
      symbolDisplay: id.symbolDisplay,
      securityStatus: sec?.status ?? "pending",
      securityFlags: sec?.flags ?? [],
    }
  })

  try {
    const raw = await args.runDisambiguation({
      prompt: DISAMBIGUATION_PROMPT,
      message: disambiguationUserMessage({
        shillText: args.shillText,
        ticker: args.ticker,
        ...(args.chainHint ? { chainHint: args.chainHint } : {}),
        candidates,
      }),
    })
    const parsed = parseDisambiguationPick(raw)
    if (!parsed.ok) return { ok: false, reason: `disambiguation:${parsed.reason}` }
    if (parsed.pick === null || parsed.confidence < TELEGRAM_ALPHA_DISAMBIG_CONFIDENCE_MIN) {
      return { ok: false, reason: "disambiguation:low-confidence" }
    }
    const identity = validateModelPick(filtered, parsed.pick)
    if (!identity) return { ok: false, reason: "disambiguation:pick-not-in-shortlist" }
    return { ok: true, identity, confidence: parsed.confidence }
  } catch {
    return { ok: false, reason: "disambiguation:session-error" }
  }
}

/**
 * Shared cashtag extraction and shortlist-bound token disambiguation.
 */

import { isValidEvmAddress, isValidSolanaAddress, normalizeEvmAddress } from "../lib/address.js"
import { CHAIN_REGISTRY, type ChainEntry } from "../lib/chains.js"
import { validateModelPick } from "../lib/resolve.js"
import { fetchSecurityGate } from "../collectors/market/security.js"
import type { FetchLike } from "../collectors/market/geckoterminal.js"
import { DISAMBIGUATION_PROMPT } from "../prompts/host.js"
import type { CanonicalIdentity } from "../contracts/schemas.js"

export const DISAMBIG_CONFIDENCE_MIN = 60
export const SHORTLIST_MAX = 5

export type DisambiguationSessionRunner = (
  args: Readonly<{ prompt: string; message: string }>,
) => Promise<string>

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
    .slice(0, SHORTLIST_MAX)
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

/** True when the day still has room for one model disambiguation call. */
export function canSpendDisambiguation(dayCount: number, cap: number): boolean {
  return dayCount < cap
}

export type DisambiguateShortlistResult =
  | { ok: true; identity: CanonicalIdentity; confidence: number; spentDisambiguation: boolean }
  | { ok: false; reason: string; spentDisambiguation: boolean }

/**
 * Filter shortlist by chain hint and hard-fail security, then confirm with a model
 * when more than one candidate remains.
 */
export async function disambiguateShortlist(args: Readonly<{
  shortlist: readonly CanonicalIdentity[]
  shillText: string
  ticker: string
  chainHint?: CanonicalIdentity["chain"]
  fetcher: FetchLike
  runDisambiguation?: DisambiguationSessionRunner
  disambiguationDayCount?: number
  disambiguationCap?: number
}>): Promise<DisambiguateShortlistResult> {
  const securityById = new Map<string, { hardFail: boolean; status: string; flags: readonly string[] }>()
  for (const id of args.shortlist.slice(0, SHORTLIST_MAX)) {
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
    return { ok: false, reason: "shortlist-filtered-empty", spentDisambiguation: false }
  }
  if (filtered.length === 1) {
    return { ok: true, identity: filtered[0]!, confidence: 100, spentDisambiguation: false }
  }
  if (!args.runDisambiguation) {
    return { ok: false, reason: "no-disambiguation-runner", spentDisambiguation: false }
  }

  const dayCount = args.disambiguationDayCount ?? 0
  const cap = args.disambiguationCap ?? Number.POSITIVE_INFINITY
  if (!canSpendDisambiguation(dayCount, cap)) {
    return { ok: false, reason: "disambiguation:daily-cap", spentDisambiguation: false }
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
    if (!parsed.ok) {
      return { ok: false, reason: `disambiguation:${parsed.reason}`, spentDisambiguation: true }
    }
    if (parsed.pick === null || parsed.confidence < DISAMBIG_CONFIDENCE_MIN) {
      return { ok: false, reason: "disambiguation:low-confidence", spentDisambiguation: true }
    }
    const identity = validateModelPick(filtered, parsed.pick)
    if (!identity) {
      return { ok: false, reason: "disambiguation:pick-not-in-shortlist", spentDisambiguation: true }
    }
    return { ok: true, identity, confidence: parsed.confidence, spentDisambiguation: true }
  } catch {
    return { ok: false, reason: "disambiguation:session-error", spentDisambiguation: true }
  }
}

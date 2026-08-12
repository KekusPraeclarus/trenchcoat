import {
  allValidCasFrom,
  chainCaTokensInText,
  chainHintFrom,
  parseChainCa,
  stripDiscordFormatting,
} from "../chat/research-intent-core.js"
import { searchDexScreener } from "../collectors/market/providers.js"
import type { FetchLike } from "../collectors/market/geckoterminal.js"
import { getChain } from "../lib/chains.js"
import { systemClock } from "../lib/clock.js"
import {
  validateConversationResearchSubject,
  type ParsedResearchSubject,
} from "./conversation.js"

export type ConversationLiveTape = Readonly<{
  status: "ok" | "failed"
  chain: string
  tokenAddress: string
  symbol?: string
  priceUsd?: number
  fdvUsd?: number
  liquidityUsd?: number
  priceChangeH24?: number
  fetchedAt: string
}>

/** Exactly one validated chain:CA (or bare CA) with tokenHint, else undefined */
export function resolveConversationCa(text: string): ParsedResearchSubject | undefined {
  const stripped = stripDiscordFormatting(text)
  const candidates: string[] = []
  const seen = new Set<string>()
  const push = (subject: string) => {
    const key = subject.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(subject)
  }

  const whole = parseChainCa(stripped)
  if (whole) push(`${whole.chainRaw}:${whole.token}`)

  const embedded = chainCaTokensInText(stripped)
  for (const hit of embedded) {
    push(`${hit.chainRaw}:${hit.token}`)
  }

  // Bare CA only when the text has no chain:CA form (avoid evilchain:0x… → bare accept)
  const hasChainCaForm = Boolean(whole) || embedded.length > 0
  if (!hasChainCaForm) {
    const hint = chainHintFrom(stripped)
    for (const ca of allValidCasFrom(stripped)) {
      if (hint) push(`${hint}:${ca}`)
      else push(ca)
    }
  }

  const validated: ParsedResearchSubject[] = []
  const validatedSeen = new Set<string>()
  for (const candidate of candidates) {
    const row = validateConversationResearchSubject(candidate)
    if (!row?.tokenHint) continue
    const key = row.subject.toLowerCase()
    if (validatedSeen.has(key)) continue
    validatedSeen.add(key)
    validated.push(row)
  }

  if (validated.length !== 1) return undefined
  return validated[0]
}

export async function fetchConversationLiveTape(args: Readonly<{
  subject: ParsedResearchSubject
  fetcher?: FetchLike
}>): Promise<ConversationLiveTape> {
  const tokenAddress = args.subject.tokenHint
  const chain = args.subject.chainHint ?? ""
  const fetchedAt = systemClock.nowIso()
  if (!tokenAddress) {
    return { status: "failed", chain, tokenAddress: "", fetchedAt }
  }

  try {
    const fetcher = args.fetcher ?? fetch
    const pairs = await searchDexScreener(fetcher, tokenAddress.slice(0, 128))
    const chainDef = chain ? getChain(chain) : undefined
    // Same pick as collect-observation — chain+address find, never liquidity rank
    const matched = pairs.find((p) => (
      (chainDef
        ? p.chainId === chainDef.dexscreenerChainId || p.chainId === chain
        : true)
      && p.baseToken.address.toLowerCase() === tokenAddress.toLowerCase()
    )) ?? pairs[0]

    if (!matched) {
      return { status: "failed", chain, tokenAddress, fetchedAt }
    }

    return {
      status: "ok",
      chain: chain || matched.chainId,
      tokenAddress,
      symbol: matched.baseToken.symbol,
      ...(matched.priceUsd === undefined ? {} : { priceUsd: matched.priceUsd }),
      ...(matched.fdv === undefined ? {} : { fdvUsd: matched.fdv }),
      ...(matched.liquidityUsd === undefined ? {} : { liquidityUsd: matched.liquidityUsd }),
      ...(matched.priceChangeH24 === undefined ? {} : { priceChangeH24: matched.priceChangeH24 }),
      fetchedAt,
    }
  } catch {
    return { status: "failed", chain, tokenAddress, fetchedAt }
  }
}

function safeTapeValue(value: string | number): string {
  return String(value).replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 128)
}

export function formatLiveTapePromptLines(tape: ConversationLiveTape): string[] {
  if (tape.status !== "ok") return []
  const lines = [
    `chain=${safeTapeValue(tape.chain)}`,
    `token=${safeTapeValue(tape.tokenAddress)}`,
  ]
  if (tape.symbol !== undefined) lines.push(`symbol=${safeTapeValue(tape.symbol)}`)
  if (tape.priceUsd !== undefined) lines.push(`priceUsd=${safeTapeValue(tape.priceUsd)}`)
  if (tape.fdvUsd !== undefined) lines.push(`fdvUsd=${safeTapeValue(tape.fdvUsd)}`)
  if (tape.liquidityUsd !== undefined) {
    lines.push(`liquidityUsd=${safeTapeValue(tape.liquidityUsd)}`)
  }
  if (tape.priceChangeH24 !== undefined) {
    lines.push(`priceChangeH24=${safeTapeValue(tape.priceChangeH24)}`)
  }
  lines.push(`fetchedAt=${safeTapeValue(tape.fetchedAt)}`)
  return lines.map((line) => `- ${line}`)
}

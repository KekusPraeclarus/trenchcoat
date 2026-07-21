import {
  allValidCasFrom,
  stripDiscordFormatting,
} from "../chat/research-intent-core.js"
import { validateAddress } from "../lib/chains.js"

export type TokenQueryKind = "contract" | "cashtag" | "ticker"

export type ValidatedTokenQuery = Readonly<{
  kind: TokenQueryKind
  query: string
  /** Form used for resolveResearchSubject */
  resolveSubject: string
}>

const CASHTAG_RE = /^\$([A-Za-z][A-Za-z0-9]{1,15})$/u
const TICKER_RE = /^[A-Za-z][A-Za-z0-9]{1,15}$/u

function includesInsensitive(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

/** Host-validate match tokenQuery against the bound candidate text */
export function validateTokenQueryAgainstCandidate(args: Readonly<{
  tokenQuery: string
  candidateText: string
}>): ValidatedTokenQuery | undefined {
  const raw = stripDiscordFormatting(args.tokenQuery).trim().slice(0, 256)
  if (!raw) return undefined
  const candidate = stripDiscordFormatting(args.candidateText)

  const cas = allValidCasFrom(raw)
  if (cas.length === 1 && cas[0]) {
    const addr = cas[0]
    if (!includesInsensitive(candidate, addr)) return undefined
    return { kind: "contract", query: addr, resolveSubject: addr }
  }
  if (cas.length > 1) return undefined

  // Standalone CA (no surrounding noise beyond the address itself)
  if (validateAddress("evm", raw) || validateAddress("base58-32", raw)) {
    if (!includesInsensitive(candidate, raw)) return undefined
    return { kind: "contract", query: raw, resolveSubject: raw }
  }

  const cash = raw.match(CASHTAG_RE)
  if (cash?.[1]) {
    const symbol = cash[1]
    if (!includesInsensitive(candidate, `$${symbol}`) && !includesInsensitive(candidate, symbol)) {
      return undefined
    }
    return { kind: "cashtag", query: `$${symbol}`, resolveSubject: symbol }
  }

  if (TICKER_RE.test(raw)) {
    // Require the ticker token to appear in the candidate (case-insensitive)
    const re = new RegExp(`(?:^|[^A-Za-z0-9])\\$?${raw}(?:[^A-Za-z0-9]|$)`, "iu")
    if (!re.test(candidate)) return undefined
    return { kind: "ticker", query: raw.toUpperCase(), resolveSubject: raw }
  }

  return undefined
}

export function findCandidateTextByProvenance(
  candidates: readonly Readonly<{ provenance: string; text: string }>[],
  provenance: string,
): string | undefined {
  const exact = candidates.find((c) => c.provenance === provenance)
  return exact?.text
}

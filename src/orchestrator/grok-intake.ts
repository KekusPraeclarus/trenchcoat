import { randomUUID } from "node:crypto"
import {
  GrokIntakePayloadSchema,
  type AuditClaim,
  type BroadcastClaimType,
  type BroadcastSeverity,
  type GrokIntakeClassHint,
  type GrokIntakePayload,
  type GrokIntakeTradeIntent,
  type GrokIntakeUrgency,
} from "../contracts/schemas.js"
import { normalizeSymbol } from "../lib/narrative-tickers.js"

const CLASS_HINT_BY_CLAIM: Partial<Record<BroadcastClaimType, GrokIntakeClassHint>> = {
  rotation: "flow",
  "narrative-emergence": "sector_heat",
  "narrative-development": "sector_heat",
  "narrative-fade": "noise",
  "sentiment-collapse": "noise",
  "token-upside": "catalyst",
  "token-downside": "catalyst",
}

const TRADE_INTENT_BY_CLAIM: Partial<Record<BroadcastClaimType, GrokIntakeTradeIntent>> = {
  "token-upside": "consider",
  "token-downside": "consider",
  rotation: "watch",
  "narrative-emergence": "watch",
  "narrative-development": "watch",
  "narrative-fade": "none",
  "sentiment-collapse": "none",
  "wallet-lifecycle": "none",
}

const URGENCY_BY_SEVERITY: Record<BroadcastSeverity, GrokIntakeUrgency> = {
  watch: "low",
  notable: "med",
  urgent: "high",
}

export function grokTickersFromSymbols(
  raw: readonly string[],
): NonNullable<GrokIntakePayload["tickers"]> {
  const tickers: NonNullable<GrokIntakePayload["tickers"]> = []
  const seen = new Set<string>()
  for (const value of raw) {
    const symbol = normalizeSymbol(value)?.toUpperCase()
    if (!symbol || seen.has(symbol)) continue
    seen.add(symbol)
    tickers.push({ symbol, stance: "neutral" })
    if (tickers.length >= 8) break
  }
  return tickers
}

export function grokUrgencyForSeverity(severity: BroadcastSeverity): GrokIntakeUrgency {
  return URGENCY_BY_SEVERITY[severity]
}

export function grokClassHintForClaim(
  claimType: BroadcastClaimType | undefined,
): GrokIntakeClassHint | undefined {
  if (!claimType) return undefined
  return CLASS_HINT_BY_CLAIM[claimType]
}

export function grokTradeIntentForClaim(
  claimType: BroadcastClaimType | undefined,
): GrokIntakeTradeIntent {
  if (!claimType) return "none"
  return TRADE_INTENT_BY_CLAIM[claimType] ?? "none"
}

export function buildGrokIntakePayload(args: Readonly<{
  text: string
  ts: string
  severity: BroadcastSeverity
  auditClaim?: AuditClaim
  tickers?: readonly string[]
  id?: string
}>): GrokIntakePayload {
  const tickers = grokTickersFromSymbols(args.tickers ?? [])
  const classHint = grokClassHintForClaim(args.auditClaim?.type)
  return GrokIntakePayloadSchema.parse({
    id: args.id ?? randomUUID(),
    ts: args.ts,
    source: "narrative-agent",
    channel: "telegram",
    text: args.text,
    urgency: grokUrgencyForSeverity(args.severity),
    trade_intent: grokTradeIntentForClaim(args.auditClaim?.type),
    ...(classHint ? { class_hint: classHint } : {}),
    ...(tickers.length > 0 ? { tickers } : {}),
  })
}

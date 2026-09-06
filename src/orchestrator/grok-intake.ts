import { createHash, randomUUID } from "node:crypto"
import {
  GrokIntakePayloadSchema,
  grokNextForClass,
  grokThesisFromText,
  type AuditClaim,
  type BroadcastClaimType,
  type BroadcastSeverity,
  type GrokIntakeClass,
  type GrokIntakePayload,
  type GrokIntakeTickerStance,
  type GrokIntakeTradeIntent,
  type GrokIntakeUrgency,
} from "../contracts/schemas.js"
import { normalizeSymbol } from "../lib/narrative-tickers.js"

const CLASS_BY_CLAIM: Partial<Record<BroadcastClaimType, GrokIntakeClass>> = {
  rotation: "flow",
  "narrative-emergence": "sector_heat",
  "narrative-development": "sector_heat",
  "narrative-fade": "noise",
  "sentiment-collapse": "noise",
  "token-upside": "catalyst",
  "token-downside": "catalyst",
}

const STANCE_BY_CLAIM: Partial<Record<BroadcastClaimType, GrokIntakeTickerStance>> = {
  rotation: "flow",
  "narrative-emergence": "flow",
  "narrative-development": "flow",
  "narrative-fade": "chop",
  "sentiment-collapse": "caution",
  "token-upside": "flow",
  "token-downside": "caution",
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

export function grokTicketId(seed: string): string {
  const h = createHash("sha256").update(`trench.intake.v1:${seed}`).digest()
  const version = h[6] ?? 0
  const variant = h[8] ?? 0
  h[6] = (version & 0x0f) | 0x40
  h[8] = (variant & 0x3f) | 0x80
  const hex = h.subarray(0, 16).toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export function grokClassForClaim(
  claimType: BroadcastClaimType | undefined,
  hasTickers: boolean,
): GrokIntakeClass {
  if (claimType) {
    const mapped = CLASS_BY_CLAIM[claimType]
    if (mapped) return mapped
  }
  return hasTickers ? "sector_heat" : "macro"
}

export function grokStanceForClaim(
  claimType: BroadcastClaimType | undefined,
): GrokIntakeTickerStance {
  if (!claimType) return "neutral"
  return STANCE_BY_CLAIM[claimType] ?? "neutral"
}

export function grokTickersFromSymbols(
  raw: readonly string[],
  stance: GrokIntakeTickerStance = "neutral",
): GrokIntakePayload["tickers"] {
  const tickers: GrokIntakePayload["tickers"] = []
  const seen = new Set<string>()
  for (const value of raw) {
    const symbol = normalizeSymbol(value)?.toUpperCase()
    if (!symbol || seen.has(symbol)) continue
    seen.add(symbol)
    tickers.push({ symbol, stance })
    if (tickers.length >= 8) break
  }
  return tickers
}

export function grokUrgencyForSeverity(severity: BroadcastSeverity): GrokIntakeUrgency {
  return URGENCY_BY_SEVERITY[severity]
}

export function grokClassHintForClaim(
  claimType: BroadcastClaimType | undefined,
): GrokIntakeClass | undefined {
  if (!claimType) return undefined
  return CLASS_BY_CLAIM[claimType]
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
  const stance = grokStanceForClaim(args.auditClaim?.type)
  const tickers = grokTickersFromSymbols(args.tickers ?? [], stance)
  const klass = grokClassForClaim(args.auditClaim?.type, tickers.length > 0)
  const next = grokNextForClass(klass, tickers.length > 0)
  return GrokIntakePayloadSchema.parse({
    schema: "trench.intake.v1",
    id: args.id ?? grokTicketId(randomUUID()),
    ts: args.ts,
    source: "narrative-agent",
    channel: "telegram",
    text: args.text,
    desk_ready: true,
    class: klass,
    class_hint: klass,
    tickers,
    thesis: grokThesisFromText(args.text),
    chain_hint: null,
    catalysts: [],
    next,
    drop_reason: next === "ignore" ? "noise-class" : null,
    links: { chart: null, twitter: null, telegram: null },
    hints: { liq_usd: null, age_min: null, mint: null },
    urgency: grokUrgencyForSeverity(args.severity),
    trade_intent: grokTradeIntentForClaim(args.auditClaim?.type),
  })
}

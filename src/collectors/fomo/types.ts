import { z } from "zod"

export const FomoChainSchema = z.enum(["solana", "base", "ethereum", "bnb", "monad"])
export type FomoChain = z.infer<typeof FomoChainSchema>

export type FomoWallet = Readonly<{ chain: string, address: string }>

export type FomoLeaderboardEntry = Readonly<{
  handle: string
  timeframe: "24h" | "7d" | "30d" | "all"
  rank: number
  pnl?: number
  winRate?: number
  trades?: number
  wallets: readonly FomoWallet[]
  xHandle?: string
  xProfileUrl?: string
  observedAt: string
}>

/** @deprecated Prefer FomoLeaderboardEntry; retained for trader-sync ranking helpers */
export type FomoTrader = Readonly<{
  handle: string
  pnl?: number
  winRate?: number
  trades?: number
  wallets: readonly FomoWallet[]
  xHandle?: string
  xProfileUrl?: string
  observedAt?: string
}>

export type FomoTradeEvent = Readonly<{
  sourceId?: string
  handle?: string
  action?: "buy" | "sell"
  chain?: string
  tokenAddress?: string
  symbol?: string
  usdAmount?: number
  txHash?: string
  eventAt: string
  observedAt: string
  wallet?: string
}>

/** @deprecated Prefer FomoTradeEvent */
export type FomoActivity = Readonly<{
  handle?: string
  action?: "buy" | "sell"
  chain?: string
  tokenAddress?: string
  symbol?: string
  usdAmount?: number
  txHash?: string
  eventAt?: string
  wallet?: string
}>

export type FomoTrendingObservation = Readonly<{
  rank: number
  chain?: string
  tokenAddress?: string
  symbol?: string
  uniqueBuyers?: number
  observedAt: string
}>

/** @deprecated Prefer FomoTrendingObservation */
export type FomoHotToken = Readonly<{
  chain?: string
  tokenAddress?: string
  symbol?: string
  uniqueBuyers?: number
}>

export type FomoAlertEvent = Readonly<{
  sourceId?: string
  kind: string
  handle?: string
  action?: "buy" | "sell"
  chain?: string
  tokenAddress?: string
  symbol?: string
  usdAmount?: number
  eventAt: string
  observedAt: string
}>

export type FomoThesis = Readonly<{
  handle?: string
  chain?: string
  tokenAddress?: string
  text: string
  eventAt: string
  observedAt: string
}>

export type FomoDerivedSignal = Readonly<{
  kind: "convergence" | "buy-pressure" | "sell-pressure" | "trending"
  chain: string
  tokenAddress: string
  symbol?: string
  handles: readonly string[]
  sourceEventIds: readonly string[]
  windowStart: string
  windowEnd: string
  observedAt: string
  usdSum?: number
}>

/** @deprecated Prefer FomoDerivedSignal */
export type FomoConvergence = Readonly<{
  chain?: string
  tokenAddress?: string
  symbol?: string
  handles: readonly string[]
  maxGainPct?: number
  detectedAt?: string
}>

export type FomoClientErrorCode =
  | "unavailable"
  | "session_expired"
  | "challenged"
  | "unauthorized"
  | "rate_limited"
  | "bad_request"
  | "not_found"
  | "upstream"
  | "malformed"
  | "budget_exhausted"
  | "size_limit"
  | "schema_drift"
  | "unvalidated"

export class FomoClientError extends Error {
  readonly code: FomoClientErrorCode
  readonly status?: number

  constructor(code: FomoClientErrorCode, message: string, status?: number) {
    super(message)
    this.name = "FomoClientError"
    this.code = code
    if (status !== undefined) this.status = status
  }
}

export type FomoGateVerdict = "pass" | "fail" | "insufficient-sample"

const GateResultSchema = z.object({
  verdict: z.enum(["pass", "fail", "insufficient-sample"]),
  sampleSize: z.number().int().nonnegative(),
  successRate: z.number().optional(),
  longestOutageHours: z.number().optional(),
  p95LatencyMs: z.number().optional(),
  challengeRate: z.number().optional(),
  sessionValidRate: z.number().optional(),
  exactAddresses: z.boolean().optional(),
  formatValidRate: z.number().optional(),
  onChainExistRate: z.number().optional(),
  resolutionRate: z.number().optional(),
  p95LagMinutes: z.number().optional(),
  novelShare: z.number().optional(),
  identityAgreeRate: z.number().optional(),
  cursorOk: z.boolean().optional(),
  rubricCompleteRate: z.number().optional(),
  timestampCoverage: z.number().optional(),
  parseSuccessRate: z.number().optional(),
  xLinkCoverage: z.number().optional(),
})

export const FomoGatesFileSchema = z.object({
  schema: z.literal(2),
  probeRunId: z.string().min(1).max(128),
  evaluatedAt: z.string().datetime(),
  fixtureHashes: z.record(z.string()).default({}),
  gates: z.object({
    provider: GateResultSchema,
    leaderboard: GateResultSchema,
    feed: GateResultSchema,
    trending: GateResultSchema,
    alerts: GateResultSchema,
    walletNomination: GateResultSchema,
    theses: GateResultSchema,
  }),
})
export type FomoGatesFile = z.infer<typeof FomoGatesFileSchema>

/** Loose raw shapes for fixture-backed SPA payloads (filled after probe) */
export const FomoRawTraderSchema = z.object({
  handle: z.string().min(1).max(64).optional(),
  userHandle: z.string().min(1).max(64).optional(),
  displayName: z.string().min(1).max(64).optional(),
  pnl: z.number().optional(),
  pnl7d: z.number().optional(),
  pnl24h: z.number().optional(),
  pnl30d: z.number().optional(),
  win_rate: z.number().optional(),
  winRate: z.number().optional(),
  trades: z.number().int().optional(),
  numTrades: z.number().int().optional(),
  swapCount: z.number().int().optional(),
  rank: z.number().int().optional(),
  timeframe: z.string().optional(),
  chain: z.string().optional(),
  address: z.string().optional(),
  evmAddress: z.string().optional(),
  wallets: z.array(z.object({
    chain: z.string(),
    address: z.string().min(20).max(128),
  }).passthrough()).optional(),
  solana_wallet: z.string().optional(),
  base_wallet: z.string().optional(),
  ethereum_wallet: z.string().optional(),
  x_handle: z.string().optional(),
  xHandle: z.string().optional(),
  twitter: z.string().optional(),
  twitter_url: z.string().optional(),
  x_url: z.string().optional(),
  socials: z.record(z.string()).optional(),
}).passthrough()

export const FomoRawActivitySchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  handle: z.string().optional(),
  userHandle: z.string().optional(),
  action: z.enum(["buy", "sell"]).optional(),
  side: z.enum(["buy", "sell"]).optional(),
  type: z.string().optional(),
  chain: z.string().optional(),
  networkId: z.number().optional(),
  token_mint: z.string().optional(),
  tokenAddress: z.string().optional(),
  mint: z.string().optional(),
  token_symbol: z.string().optional(),
  symbol: z.string().optional(),
  usd_amount: z.number().optional(),
  usdAmount: z.number().optional(),
  tx_hash: z.string().optional(),
  timestamp: z.union([z.number(), z.string()]).optional(),
  observed_at: z.union([z.number(), z.string()]).optional(),
  created_at: z.union([z.number(), z.string()]).optional(),
  createdAt: z.union([z.number(), z.string()]).optional(),
  wallet: z.string().optional(),
  body: z.record(z.unknown()).optional(),
}).passthrough()

export const FomoRawConvergenceSchema = z.object({
  mint: z.string().optional(),
  token_mint: z.string().optional(),
  tokenAddress: z.string().optional(),
  symbol: z.string().optional(),
  chain: z.string().optional(),
  wallets_involved: z.array(z.object({
    handle: z.string().optional(),
    amount: z.number().optional(),
    win_rate: z.number().optional(),
  }).passthrough()).optional(),
  handles: z.array(z.string()).optional(),
  max_gain_pct: z.number().optional(),
  detected_at: z.union([z.number(), z.string()]).optional(),
}).passthrough()

export const FomoRawHotTokenSchema = z.object({
  mint: z.string().optional(),
  token_mint: z.string().optional(),
  tokenAddress: z.string().optional(),
  symbol: z.string().optional(),
  chain: z.string().optional(),
  networkId: z.number().optional(),
  unique_buyers: z.number().int().optional(),
  uniqueBuyers: z.number().int().optional(),
  rank: z.number().int().optional(),
  token: z.object({
    address: z.string().optional(),
    networkId: z.number().optional(),
    symbol: z.string().optional(),
  }).passthrough().optional(),
}).passthrough()

export const FomoRawThesisSchema = z.object({
  handle: z.string().optional(),
  chain: z.string().optional(),
  mint: z.string().optional(),
  token_mint: z.string().optional(),
  tokenAddress: z.string().optional(),
  text: z.string().optional(),
  thesis: z.string().optional(),
  timestamp: z.union([z.number(), z.string()]).optional(),
  created_at: z.union([z.number(), z.string()]).optional(),
}).passthrough()

export const FomoRawAlertSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  kind: z.string().optional(),
  type: z.string().optional(),
  handle: z.string().optional(),
  action: z.enum(["buy", "sell"]).optional(),
  side: z.enum(["buy", "sell"]).optional(),
  chain: z.string().optional(),
  token_mint: z.string().optional(),
  tokenAddress: z.string().optional(),
  mint: z.string().optional(),
  symbol: z.string().optional(),
  usd_amount: z.number().optional(),
  timestamp: z.union([z.number(), z.string()]).optional(),
  created_at: z.union([z.number(), z.string()]).optional(),
}).passthrough()

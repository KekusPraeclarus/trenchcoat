import { z } from "zod"

export const PumpFeedTabSchema = z.enum(["fyp", "top", "news", "following"])
export type PumpFeedTab = z.infer<typeof PumpFeedTabSchema>

export type PumpFeedItem = Readonly<{
  itemId: string
  author: string
  tab: PumpFeedTab
  mint?: string
  chain?: string
  observedAt: string
}>

export type PumpLeaderboardEntry = Readonly<{
  handle: string
  rank: number
  observedAt: string
}>

export type PumpCall = Readonly<{
  callerId: string
  chain: string
  tokenAddress: string
  calledAt: string
  itemId?: string
  feedTab?: PumpFeedTab
}>

export type PumpCallerProfile = Readonly<{
  handle: string
  calls: readonly PumpCall[]
}>

export type PumpClientErrorCode =
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

export class PumpClientError extends Error {
  readonly code: PumpClientErrorCode
  readonly status?: number

  constructor(code: PumpClientErrorCode, message: string, status?: number) {
    super(message)
    this.name = "PumpClientError"
    this.code = code
    if (status !== undefined) this.status = status
  }
}

export type PumpGateVerdict = "pass" | "fail" | "insufficient-sample"

const GateResultSchema = z.object({
  verdict: z.enum(["pass", "fail", "insufficient-sample"]),
  sampleSize: z.number().int().nonnegative(),
  successRate: z.number().optional(),
  longestOutageHours: z.number().optional(),
  p95LatencyMs: z.number().optional(),
  challengeRate: z.number().optional(),
  sessionValidRate: z.number().optional(),
  cursorOk: z.boolean().optional(),
  parseSuccessRate: z.number().optional(),
})

export const PumpGatesFileSchema = z.object({
  schema: z.literal(1),
  probeRunId: z.string().min(1).max(128),
  evaluatedAt: z.string().datetime(),
  fixtureHashes: z.record(z.string()).default({}),
  gates: z.object({
    provider: GateResultSchema,
    feed: GateResultSchema,
    leaderboard: GateResultSchema,
    following: GateResultSchema,
  }),
})
export type PumpGatesFile = z.infer<typeof PumpGatesFileSchema>

export type PumpDataSource = {
  readFeed(args: Readonly<{
    tab: PumpFeedTab
    cursor?: string
    maxPages?: number
  }>): Promise<readonly PumpFeedItem[]>
  readLeaderboard(args?: Readonly<{
    maxHandles?: number
  }>): Promise<readonly PumpLeaderboardEntry[]>
  readCallerProfile(handle: string): Promise<PumpCallerProfile>
  captureCallChart?(handle: string, mint: string): Promise<Buffer | undefined>
  close(): Promise<void>
}

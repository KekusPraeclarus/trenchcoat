import { z } from "zod"

export const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
export const SafeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)
export const IsoTimestampSchema = z.string().datetime({ offset: true })
export const ChainSlugSchema = z.enum(["solana", "ethereum", "base", "bsc", "robinhood"])
export const AddressSchema = z.string().min(32).max(128)

export const CanonicalIdentitySchema = z.object({
  chain: ChainSlugSchema,
  tokenAddress: AddressSchema,
  pairAddress: AddressSchema,
  symbolDisplay: z.string().min(1).max(32),
  resolution: z.enum(["resolved", "model-confirmed", "ambiguous", "unsupported-chain"]),
  resolutionConfidence: z.number().int().min(0).max(100).optional(),
  resolutionNote: z.string().max(280).optional(),
})
export type CanonicalIdentity = z.infer<typeof CanonicalIdentitySchema>

export const FreshnessTierSchema = z.enum(["live", "stale", "expired"])
export const TrustSchema = z.literal("untrusted-external")

export const SnapshotItemSchema = z.object({
  provenance: z.string().min(1).max(256),
  text: z.string().max(20_000),
  url: z.string().url().optional(),
  ts: IsoTimestampSchema,
  ageSec: z.number().int().nonnegative(),
  freshnessTier: FreshnessTierSchema,
  dedupeKey: z.string().optional(),
  clusterId: z.string().optional(),
})

export const SnapshotEnvelopeSchema = z.object({
  source: z.string().min(1).max(128),
  fetchedAt: IsoTimestampSchema,
  trust: TrustSchema,
  items: z.array(SnapshotItemSchema).max(500),
})
export type SnapshotEnvelope = z.infer<typeof SnapshotEnvelopeSchema>

export const SignalUseSchema = z.enum(["driver", "confirm", "veto", "observed"])
export const VerdictSchema = z.enum(["track", "drop", "ignore", "revisit"])

export const DecisionCardSchema = z.object({
  decisionId: SafeIdSchema,
  runId: SafeIdSchema,
  decisionTs: IsoTimestampSchema,
  verdict: VerdictSchema,
  identity: CanonicalIdentitySchema.optional(),
  thesis: z.string().min(1).max(500),
  horizonHours: z.union([z.literal(24), z.literal(72), z.literal(168)]),
  invalidation: z.string().min(1).max(500),
  drivers: z.array(z.string()).min(1).max(8),
  confidence: z.number().int().min(0).max(100),
  signalUse: z.record(SignalUseSchema),
  sources: z.array(z.string()).max(32),
  clusters: z.number().int().nonnegative(),
  countercase: z.string().min(1).max(500),
  gate: z.string().min(1).max(500),
})
export type DecisionCard = z.infer<typeof DecisionCardSchema>

export const BroadcastSeveritySchema = z.enum(["watch", "notable", "urgent"])
export const BroadcastClaimTypeSchema = z.enum([
  "narrative-emergence",
  "narrative-fade",
  "rotation",
  "sentiment-collapse",
  "token-downside",
  "token-upside",
  "wallet-lifecycle",
])
export const BroadcastDirectionSchema = z.enum(["down", "rotation", "up", "lifecycle"])

export const AuditClaimSchema = z.object({
  type: BroadcastClaimTypeSchema,
  subject: z.string().min(1).max(256),
  direction: BroadcastDirectionSchema,
  horizonHours: z.number().int().min(1).max(168),
  verificationRule: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
})

export const BroadcastItemSchema = z.object({
  severity: BroadcastSeveritySchema,
  text: z.string().min(1).max(280),
  refs: z.array(z.string().regex(/^state\/[A-Za-z0-9._/-]+$/u)).max(10),
  auditClaim: AuditClaimSchema,
})
export type BroadcastItem = z.infer<typeof BroadcastItemSchema>

export const RouterEventTypeSchema = z.enum(["finding.broadcast", "wallet.lifecycle"])
export const RouterEventSchema = z.object({
  schema: z.literal(1),
  eventId: Sha256Schema,
  occurredAt: IsoTimestampSchema,
  runId: SafeIdSchema,
  type: RouterEventTypeSchema,
  severity: BroadcastSeveritySchema.or(z.literal("lifecycle")),
  text: z.string().min(1).max(280),
  refs: z.array(z.string()).max(16),
  auditClaim: AuditClaimSchema.optional(),
  walletTransition: z.object({
    walletId: z.string(),
    chain: ChainSlugSchema,
    address: AddressSchema,
    action: z.enum(["added", "dropped"]),
    reasonCode: z.string(),
    reasonLine: z.string().max(280),
  }).optional(),
})
export type RouterEvent = z.infer<typeof RouterEventSchema>

export const WatchlistStatusSchema = z.enum([
  "tracking",
  "watching",
  "dropped",
  "ignored",
  "revisit",
])

export const WatchlistEntrySchema = z.object({
  schema: z.literal(1),
  identity: CanonicalIdentitySchema,
  status: WatchlistStatusSchema,
  addedAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  lastDecisionId: SafeIdSchema.optional(),
  notes: z.string().max(500).optional(),
})
export type WatchlistEntry = z.infer<typeof WatchlistEntrySchema>

export const WatchlistFileSchema = z.object({
  schema: z.literal(1),
  entries: z.array(WatchlistEntrySchema).max(500),
})
export type WatchlistFile = z.infer<typeof WatchlistFileSchema>

export const SourceRecordSchema = z.object({
  schema: z.literal(1),
  sourceId: SafeIdSchema,
  handle: z.string().min(1).max(128),
  platform: z.enum(["x", "telegram", "farcaster"]),
  score: z.number().min(0).max(1),
  scoreUpdatedAt: IsoTimestampSchema.optional(),
  docked: z.boolean().default(false),
  dockReason: z.string().max(280).optional(),
  rugAdjacency: z.number().int().nonnegative().default(0),
})
export type SourceRecord = z.infer<typeof SourceRecordSchema>

export const SourcesFileSchema = z.object({
  schema: z.literal(1),
  sources: z.array(SourceRecordSchema).max(5_000),
})
export type SourcesFile = z.infer<typeof SourcesFileSchema>

export const LedgerPositionStatusSchema = z.enum([
  "entry-pending",
  "open",
  "exit-pending",
  "closed",
  "censored",
])

export const LedgerPositionSchema = z.object({
  schema: z.literal(1),
  positionId: SafeIdSchema,
  decisionId: SafeIdSchema,
  identity: CanonicalIdentitySchema,
  status: LedgerPositionStatusSchema,
  openedAt: IsoTimestampSchema,
  closedAt: IsoTimestampSchema.optional(),
  entryPrice: z.number().positive().optional(),
  exitPrice: z.number().positive().optional(),
  entryObservationHash: Sha256Schema.optional(),
  exitObservationHash: Sha256Schema.optional(),
})
export type LedgerPosition = z.infer<typeof LedgerPositionSchema>

export const LedgerFileSchema = z.object({
  schema: z.literal(1),
  positions: z.array(LedgerPositionSchema).max(10_000),
})
export type LedgerFile = z.infer<typeof LedgerFileSchema>

export const ResearchQueueEntrySchema = z.object({
  schema: z.literal(1),
  queueId: SafeIdSchema,
  subject: z.string().min(1).max(256),
  priority: z.number().int().min(0).max(100),
  enqueuedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  provenance: z.array(z.string()).max(32),
  reason: z.string().max(280),
})
export type ResearchQueueEntry = z.infer<typeof ResearchQueueEntrySchema>

export const ResearchQueueFileSchema = z.object({
  schema: z.literal(1),
  entries: z.array(ResearchQueueEntrySchema).max(1_000),
})
export type ResearchQueueFile = z.infer<typeof ResearchQueueFileSchema>

export const WalletStatusSchema = z.enum([
  "candidate",
  "tracking-probation",
  "tracking",
  "dropped",
  "excluded",
])

export const WalletRecordSchema = z.object({
  schema: z.literal(1),
  walletId: SafeIdSchema,
  chain: ChainSlugSchema,
  address: AddressSchema,
  status: WalletStatusSchema,
  deterministicScore: z.number().min(0).max(1).optional(),
  llmScore: z.number().min(0).max(1).optional(),
  blendedScore: z.number().min(0).max(1).optional(),
  addedAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  lastEligibleAt: IsoTimestampSchema.optional(),
  operatorReason: z.string().max(280).optional(),
})
export type WalletRecord = z.infer<typeof WalletRecordSchema>

export const WalletsFileSchema = z.object({
  schema: z.literal(1),
  wallets: z.array(WalletRecordSchema).max(5_000),
})
export type WalletsFile = z.infer<typeof WalletsFileSchema>

export const WalletTransitionSchema = z.object({
  schema: z.literal(1),
  transitionId: Sha256Schema,
  walletId: SafeIdSchema,
  chain: ChainSlugSchema,
  address: AddressSchema,
  action: z.enum(["added", "dropped"]),
  reasonCode: z.string().min(1).max(64),
  reasonLine: z.string().min(1).max(280),
  occurredAt: IsoTimestampSchema,
  runId: SafeIdSchema,
  evidenceHash: Sha256Schema,
})
export type WalletTransition = z.infer<typeof WalletTransitionSchema>

export const TelemetryRunSchema = z.object({
  schema: z.literal(1),
  runId: SafeIdSchema,
  job: SafeIdSchema,
  startedAt: IsoTimestampSchema,
  finishedAt: IsoTimestampSchema.optional(),
  model: z.string().optional(),
  tokenUsage: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }).optional(),
  rateGate: z.array(z.object({
    host: z.string(),
    tokens: z.number(),
    monthlyUsed: z.number(),
  })).optional(),
  incidents: z.array(z.string()).max(100).default([]),
})
export type TelemetryRun = z.infer<typeof TelemetryRunSchema>

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

export const XHandleSchema = z.string().regex(/^[A-Za-z0-9_]{1,15}$/u)
export const SourceLifecycleStatusSchema = z.enum([
  "probation",
  "managed",
  "demoted",
])

export const SourcePerformanceSchema = z.object({
  eligibleCalls: z.number().int().nonnegative(),
  distinctTokens: z.number().int().nonnegative(),
  settledCalls: z.number().int().nonnegative(),
  hits: z.number().int().nonnegative(),
  coverage: z.number().min(0).max(1),
  hitMean: z.number().min(0).max(1),
  hitLb95: z.number().min(0).max(1),
  medianExcess72h: z.number(),
  rugExposure: z.number().min(0).max(1),
  lastEligibleCallAt: IsoTimestampSchema.optional(),
  score: z.number().min(0).max(1),
  scoreCutoff: IsoTimestampSchema,
})
export type SourcePerformance = z.infer<typeof SourcePerformanceSchema>

export const SourceDiscoveryOriginSchema = z.enum([
  "fyp",
  "operator-list-1",
  "operator-list-2",
])
export type SourceDiscoveryOrigin = z.infer<typeof SourceDiscoveryOriginSchema>

export const SourceCandidateSchema = z.object({
  schema: z.literal(1),
  sourceId: SafeIdSchema,
  handle: XHandleSchema,
  discoveredFrom: SourceDiscoveryOriginSchema,
  firstSeenAt: IsoTimestampSchema,
  lastSeenAt: IsoTimestampSchema,
  status: SourceLifecycleStatusSchema,
  promotedAt: IsoTimestampSchema.optional(),
  demotedAt: IsoTimestampSchema.optional(),
  cooldownUntil: IsoTimestampSchema.optional(),
  callsAtDemotion: z.number().int().nonnegative().optional(),
  consecutiveBelowFloorEpochs: z.number().int().nonnegative().default(0),
  hardDocked: z.boolean().default(false),
  lastReviewEpoch: SafeIdSchema.optional(),
  evidenceHash: Sha256Schema,
})
export type SourceCandidate = z.infer<typeof SourceCandidateSchema>

export const XEngagementActionSchema = z.enum(["like", "follow", "unfollow"])
export const XEngagementReasonCodeSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u)
export const XTopicLabelSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/u)

export const XEngagementProposalItemSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("like"),
    postId: z.string().regex(/^\d{5,25}$/u),
    authorHandle: XHandleSchema,
    reasonCode: XEngagementReasonCodeSchema,
    topics: z.array(XTopicLabelSchema).max(8).default([]),
    rationale: z.string().min(1).max(280),
  }),
  z.object({
    action: z.literal("follow"),
    handle: XHandleSchema,
    reasonCode: XEngagementReasonCodeSchema,
    topics: z.array(XTopicLabelSchema).max(8).default([]),
    rationale: z.string().min(1).max(280),
  }),
  z.object({
    action: z.literal("unfollow"),
    handle: XHandleSchema,
    reasonCode: XEngagementReasonCodeSchema,
    topics: z.array(XTopicLabelSchema).max(8).default([]),
    rationale: z.string().min(1).max(280),
  }),
])
export type XEngagementProposalItem = z.infer<typeof XEngagementProposalItemSchema>

export const XEngagementProposalFileSchema = z.object({
  schema: z.literal(1),
  runId: SafeIdSchema,
  proposedAt: IsoTimestampSchema,
  items: z.array(XEngagementProposalItemSchema).max(50),
})
export type XEngagementProposalFile = z.infer<typeof XEngagementProposalFileSchema>

export const XEngagementDecisionSchema = z.object({
  schema: z.literal(1),
  actionId: Sha256Schema,
  action: XEngagementActionSchema,
  target: z.string().min(1).max(64),
  reasonCode: XEngagementReasonCodeSchema,
  topics: z.array(XTopicLabelSchema).max(8).default([]),
  accepted: z.boolean(),
  rejectReason: z.string().max(120).optional(),
  runId: SafeIdSchema,
  decidedAt: IsoTimestampSchema,
})
export type XEngagementDecision = z.infer<typeof XEngagementDecisionSchema>

export const XEngagementReceiptSchema = z.object({
  schema: z.literal(1),
  receiptId: Sha256Schema,
  actionId: Sha256Schema,
  action: XEngagementActionSchema,
  target: z.string().min(1).max(64),
  attemptedAt: IsoTimestampSchema,
  verified: z.boolean(),
  ambiguous: z.boolean(),
  error: z.string().max(500).optional(),
})
export type XEngagementReceipt = z.infer<typeof XEngagementReceiptSchema>

export const XEngagementFileSchema = z.object({
  schema: z.literal(1),
  followedHandles: z.array(XHandleSchema).max(5_000),
  likedPostIds: z.array(z.string().regex(/^\d{5,25}$/u)).max(50_000),
  lastLikedAt: z.record(z.string(), IsoTimestampSchema).default({}),
  lastFollowedAt: z.record(z.string(), IsoTimestampSchema).default({}),
  pendingActionIds: z.array(Sha256Schema).max(10_000),
  decisions: z.array(XEngagementDecisionSchema).max(100_000),
  receipts: z.array(XEngagementReceiptSchema).max(100_000),
  daily: z.object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    likes: z.number().int().nonnegative().default(0),
    follows: z.number().int().nonnegative().default(0),
    unfollows: z.number().int().nonnegative().default(0),
  }),
})
export type XEngagementFile = z.infer<typeof XEngagementFileSchema>

export const SourceLifecycleTransitionSchema = z.object({
  schema: z.literal(1),
  transitionId: Sha256Schema,
  sourceId: SafeIdSchema,
  handle: XHandleSchema,
  action: z.enum(["promoted", "demoted"]),
  reasonCode: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
  occurredAt: IsoTimestampSchema,
  epochId: SafeIdSchema,
  evidenceHash: Sha256Schema,
  fromStatus: SourceLifecycleStatusSchema,
  toStatus: SourceLifecycleStatusSchema,
})
export type SourceLifecycleTransition = z.infer<typeof SourceLifecycleTransitionSchema>

export const SourceLifecycleFileSchema = z.object({
  schema: z.literal(1),
  managedListId: z.string().regex(/^\d+$/u).optional(),
  managedListUrl: z.string().url().optional(),
  candidates: z.array(SourceCandidateSchema).max(10_000),
  transitions: z.array(SourceLifecycleTransitionSchema).max(100_000),
  pendingTransitionIds: z.array(Sha256Schema).max(10_000),
})
export type SourceLifecycleFile = z.infer<typeof SourceLifecycleFileSchema>

export const XListSyncReceiptSchema = z.object({
  schema: z.literal(1),
  syncId: Sha256Schema,
  managedListId: z.string().regex(/^\d+$/u),
  attemptedAt: IsoTimestampSchema,
  desiredHandlesHash: Sha256Schema,
  added: z.array(XHandleSchema),
  removed: z.array(XHandleSchema),
  verified: z.boolean(),
  ambiguous: z.boolean(),
  error: z.string().max(500).optional(),
})
export type XListSyncReceipt = z.infer<typeof XListSyncReceiptSchema>

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

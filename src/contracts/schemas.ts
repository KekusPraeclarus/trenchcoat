import { z } from "zod"
import { GENERATED_CHAIN_SLUGS } from "../lib/chains.generated.js"

export const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
export const SafeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)
export const IsoTimestampSchema = z.string().datetime({ offset: true })
export const ChainSlugSchema = z.enum(
  GENERATED_CHAIN_SLUGS as unknown as [string, ...string[]],
)
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

/** Hard ceiling for every inbox SnapshotEnvelope — collectors must cap before write */
export const SNAPSHOT_MAX_ITEMS = 500

export const SnapshotEnvelopeSchema = z.object({
  source: z.string().min(1).max(128),
  fetchedAt: IsoTimestampSchema,
  trust: TrustSchema,
  items: z.array(SnapshotItemSchema).max(SNAPSHOT_MAX_ITEMS),
})
export type SnapshotEnvelope = z.infer<typeof SnapshotEnvelopeSchema>

export const SignalUseSchema = z.enum(["driver", "confirm", "veto", "observed"])
export const VerdictSchema = z.enum(["track", "drop", "ignore", "revisit"])
export type Verdict = z.infer<typeof VerdictSchema>
export const ProjectClassificationSchema = z.enum([
  "memecoin",
  "utility",
  "infrastructure",
  "unknown",
])
export type ProjectClassification = z.infer<typeof ProjectClassificationSchema>
export const MintAssessmentSchema = z.object({
  active: z.boolean(),
  justified: z.boolean(),
  rationale: z.string().min(1).max(500),
})
export type MintAssessment = z.infer<typeof MintAssessmentSchema>
export const WatchlistStatusSchema = z.enum([
  "tracking",
  "watching",
  "dropped",
  "ignored",
  "revisit",
])
export type WatchlistStatus = z.infer<typeof WatchlistStatusSchema>

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
  /** Required by host when scanner flags active mint and verdict is track */
  projectClassification: ProjectClassificationSchema.optional(),
  mintAssessment: MintAssessmentSchema.optional(),
  policyVersion: SafeIdSchema.optional(),
  assignment: z.enum(["baseline", "candidate", "shadow"]).optional(),
})
export type DecisionCard = z.infer<typeof DecisionCardSchema>

export const DecisionProposalSchema = z.object({
  schema: z.literal(1),
  proposalId: SafeIdSchema,
  runId: SafeIdSchema,
  proposedAt: IsoTimestampSchema,
  card: DecisionCardSchema,
  provenanceIds: z.array(z.string().min(1).max(256)).max(64).default([]),
  watchlistStatus: WatchlistStatusSchema.optional(),
  externalEffects: z.array(z.enum([
    "broadcast",
    "router",
    "x-engagement",
    "x-list",
    "fc-engagement",
    "fc-follow",
    "wallet-lifecycle",
  ])).max(8).default([]),
})
export type DecisionProposal = z.infer<typeof DecisionProposalSchema>

export const DecisionProposalFileSchema = z.object({
  schema: z.literal(1),
  runId: SafeIdSchema,
  proposedAt: IsoTimestampSchema,
  proposals: z.array(DecisionProposalSchema).max(50),
})
export type DecisionProposalFile = z.infer<typeof DecisionProposalFileSchema>

export const ValidationReceiptSchema = z.object({
  schema: z.literal(1),
  receiptId: Sha256Schema,
  proposalId: SafeIdSchema,
  runId: SafeIdSchema,
  accepted: z.boolean(),
  rejectReason: z.string().max(280).optional(),
  appliedDecisionId: SafeIdSchema.optional(),
  blockedExternalEffects: z.array(z.string()).max(8).default([]),
  provenanceIds: z.array(z.string().min(1).max(256)).max(64).default([]),
  gateReceiptId: Sha256Schema.optional(),
  resolutionReceiptId: Sha256Schema.optional(),
  decidedAt: IsoTimestampSchema,
  policyVersion: SafeIdSchema,
  assignment: z.enum(["baseline", "candidate", "shadow"]),
})
export type ValidationReceipt = z.infer<typeof ValidationReceiptSchema>

export const PolicyVersionSchema = z.object({
  schema: z.literal(1),
  policyVersion: SafeIdSchema,
  kind: z.enum(["baseline", "candidate"]),
  commit: z.string().min(7).max(64),
  createdAt: IsoTimestampSchema,
  hypothesisId: SafeIdSchema.optional(),
  allowlistPaths: z.array(z.string()).max(64).default([]),
})
export type PolicyVersion = z.infer<typeof PolicyVersionSchema>

export const EpisodeAssignmentSchema = z.object({
  schema: z.literal(1),
  episodeId: SafeIdSchema,
  assignment: z.enum(["baseline", "candidate"]),
  policyVersion: SafeIdSchema,
  hypothesisId: SafeIdSchema.optional(),
  assignedAt: IsoTimestampSchema,
})
export type EpisodeAssignment = z.infer<typeof EpisodeAssignmentSchema>

export const BroadcastSeveritySchema = z.enum(["watch", "notable", "urgent"])
export const BroadcastClaimTypeSchema = z.enum([
  "narrative-emergence",
  "narrative-fade",
  "narrative-development",
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
export type AuditClaim = z.infer<typeof AuditClaimSchema>

/** Agent proposal refs: host-owned state or same-run frozen inbox evidence */
export const BroadcastProposalRefSchema = z.string().regex(
  /^(?:state\/[A-Za-z0-9._/-]+|inbox\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/[A-Za-z0-9._/-]+)$/u,
)

/** Durable event refs after host canonicalization (state stays; inbox → sealed archive) */
export const BroadcastDurableRefSchema = z.string().regex(
  /^(?:state\/[A-Za-z0-9._/-]+|archive\/runs\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/inbox\/[A-Za-z0-9._/-]+)$/u,
)

export const BroadcastItemSchema = z.object({
  severity: BroadcastSeveritySchema,
  text: z.string().min(1).max(280),
  // Accept proposal or durable shapes so ingest can canonicalize then stage
  refs: z.array(z.union([BroadcastProposalRefSchema, BroadcastDurableRefSchema])).max(10),
  auditClaim: AuditClaimSchema,
})
export type BroadcastItem = z.infer<typeof BroadcastItemSchema>

export const RouterEventTypeSchema = z.enum([
  "finding.broadcast",
  "finding.correction",
  "wallet.lifecycle",
  "wallet.convergence",
])

/** Per-destination fanout text. Optional; excluded from eventId derivation. */
export const RouterChannelPayloadsSchema = z.object({
  telegram: z.object({
    text: z.string().min(1).max(64_000),
  }).optional(),
  discord: z.object({
    text: z.string().min(1).max(1_000),
  }).optional(),
}).strict()
export type RouterChannelPayloads = z.infer<typeof RouterChannelPayloadsSchema>

export const RouterEventSchema = z.object({
  schema: z.literal(1),
  eventId: Sha256Schema,
  occurredAt: IsoTimestampSchema,
  runId: SafeIdSchema,
  type: RouterEventTypeSchema,
  severity: BroadcastSeveritySchema.or(z.literal("lifecycle")).or(z.literal("info")),
  text: z.string().min(1).max(8_000),
  refs: z.array(z.string()).max(16),
  auditClaim: AuditClaimSchema.optional(),
  channels: RouterChannelPayloadsSchema.optional(),
  correction: z.object({
    incidentId: z.string().min(8).max(128),
    invalidatedClaimIds: z.array(z.string().min(8).max(128)).min(1).max(64),
    originalEventIds: z.array(z.string().min(1).max(128)).max(64).default([]),
    replyToProviderMessageId: z.string().min(1).max(128).optional(),
  }).optional(),
  walletTransition: z.object({
    walletId: z.string(),
    chain: ChainSlugSchema,
    address: AddressSchema,
    action: z.enum(["added", "dropped"]),
    reasonCode: z.string(),
    reasonLine: z.string().max(280),
  }).optional(),
  walletConvergence: z.object({
    chain: ChainSlugSchema,
    tokenAddress: AddressSchema,
    walletIds: z.array(z.string().min(1).max(128)).min(2).max(64),
    windowMinutes: z.number().int().positive().max(1_440),
    firstBuyAt: IsoTimestampSchema,
    label: z.literal("UNVERIFIED WALLET CONVERGENCE"),
  }).optional(),
})
export type RouterEvent = z.infer<typeof RouterEventSchema>

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
  "fomo-leaderboard",
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

/** Settlement stage for X engagement; optional for receipts written before stages existed */
export const XEngagementOutcomeSchema = z.enum([
  "already-satisfied",
  "verified",
  "verified-after-attempt-error",
  "ambiguous",
  "failed-before-mutation",
])
export type XEngagementOutcome = z.infer<typeof XEngagementOutcomeSchema>

export const XEngagementReceiptSchema = z.object({
  schema: z.literal(1),
  receiptId: Sha256Schema,
  actionId: Sha256Schema,
  action: XEngagementActionSchema,
  target: z.string().min(1).max(64),
  attemptedAt: IsoTimestampSchema,
  verified: z.boolean(),
  ambiguous: z.boolean(),
  /** Preferred settlement label; when absent, derive from verified/ambiguous */
  outcome: XEngagementOutcomeSchema.optional(),
  attemptError: z.string().max(500).optional(),
  verificationError: z.string().max(500).optional(),
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

export const XFypEligiblePostSchema = z.object({
  postId: z.string().regex(/^\d{5,25}$/u),
  author: XHandleSchema,
})
export type XFypEligiblePost = z.infer<typeof XFypEligiblePostSchema>

export const XFypEligibleManifestSchema = z.object({
  schema: z.literal(1),
  runId: SafeIdSchema,
  collectedAt: IsoTimestampSchema,
  posts: z.array(XFypEligiblePostSchema).max(500),
})
export type XFypEligibleManifest = z.infer<typeof XFypEligibleManifestSchema>

export const XBotHealthActionSchema = z.object({
  action: XEngagementActionSchema,
  target: z.string().min(1).max(64),
  runId: SafeIdSchema,
  attemptedAt: IsoTimestampSchema,
})
export type XBotHealthAction = z.infer<typeof XBotHealthActionSchema>

export const XBotHealthFailureSchema = z.object({
  action: XEngagementActionSchema.optional(),
  target: z.string().min(1).max(64).optional(),
  runId: SafeIdSchema.optional(),
  attemptedAt: IsoTimestampSchema,
  error: z.string().max(500),
  ambiguous: z.boolean().default(false),
})
export type XBotHealthFailure = z.infer<typeof XBotHealthFailureSchema>

export const XBotHealthSchema = z.object({
  schema: z.literal(1),
  updatedAt: IsoTimestampSchema,
  consecutiveFailures: z.number().int().nonnegative().max(10_000),
  lastVerifiedAction: XBotHealthActionSchema.optional(),
  lastFailure: XBotHealthFailureSchema.optional(),
})
export type XBotHealth = z.infer<typeof XBotHealthSchema>

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

/** Farcaster fname: lowercase alphanumeric + hyphen, max 16 */
export const FcHandleSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,15}$/u)
export const FcCastHashSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/u)
export const FcFidSchema = z.number().int().positive()

export const FcDiscoveryOriginSchema = z.enum([
  "fc-fyp",
  "fc-channel-1",
  "fc-channel-2",
])
export type FcDiscoveryOrigin = z.infer<typeof FcDiscoveryOriginSchema>

export const FcSourceCandidateSchema = z.object({
  schema: z.literal(1),
  sourceId: SafeIdSchema,
  handle: FcHandleSchema,
  fid: FcFidSchema,
  discoveredFrom: FcDiscoveryOriginSchema,
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
export type FcSourceCandidate = z.infer<typeof FcSourceCandidateSchema>

export const FcSourceLifecycleTransitionSchema = z.object({
  schema: z.literal(1),
  transitionId: Sha256Schema,
  sourceId: SafeIdSchema,
  handle: FcHandleSchema,
  fid: FcFidSchema,
  action: z.enum(["promoted", "demoted"]),
  reasonCode: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
  occurredAt: IsoTimestampSchema,
  epochId: SafeIdSchema,
  evidenceHash: Sha256Schema,
  fromStatus: SourceLifecycleStatusSchema,
  toStatus: SourceLifecycleStatusSchema,
})
export type FcSourceLifecycleTransition = z.infer<typeof FcSourceLifecycleTransitionSchema>

export const FcSourceLifecycleFileSchema = z.object({
  schema: z.literal(1),
  botFid: FcFidSchema.optional(),
  candidates: z.array(FcSourceCandidateSchema).max(10_000),
  transitions: z.array(FcSourceLifecycleTransitionSchema).max(100_000),
  pendingTransitionIds: z.array(Sha256Schema).max(10_000),
})
export type FcSourceLifecycleFile = z.infer<typeof FcSourceLifecycleFileSchema>

export const FcFollowSyncReceiptSchema = z.object({
  schema: z.literal(1),
  syncId: Sha256Schema,
  botFid: FcFidSchema,
  attemptedAt: IsoTimestampSchema,
  desiredFidsHash: Sha256Schema,
  followed: z.array(FcFidSchema),
  unfollowed: z.array(FcFidSchema),
  verified: z.boolean(),
  ambiguous: z.boolean(),
  dryRun: z.boolean().optional(),
  desiredFids: z.array(FcFidSchema).optional(),
  actualFids: z.array(FcFidSchema).optional(),
  refetchedAt: IsoTimestampSchema.optional(),
  idempotentFollows: z.array(FcFidSchema).optional(),
  idempotentUnfollows: z.array(FcFidSchema).optional(),
  error: z.string().max(500).optional(),
})
export type FcFollowSyncReceipt = z.infer<typeof FcFollowSyncReceiptSchema>

/** Agent may propose likes only — follow/unfollow belong to host lifecycle (INV-S22). */
export const FcEngagementProposalItemSchema = z.object({
  action: z.literal("like"),
  castHash: FcCastHashSchema,
  authorHandle: FcHandleSchema,
  reasonCode: XEngagementReasonCodeSchema,
  topics: z.array(XTopicLabelSchema).max(8).default([]),
  rationale: z.string().min(1).max(280),
})
export type FcEngagementProposalItem = z.infer<typeof FcEngagementProposalItemSchema>

export const FcEngagementProposalFileSchema = z.object({
  schema: z.literal(1),
  runId: SafeIdSchema,
  proposedAt: IsoTimestampSchema,
  items: z.array(FcEngagementProposalItemSchema).max(50),
})
export type FcEngagementProposalFile = z.infer<typeof FcEngagementProposalFileSchema>

export const FcEngagementDecisionSchema = z.object({
  schema: z.literal(1),
  actionId: Sha256Schema,
  action: z.literal("like"),
  target: FcCastHashSchema,
  reasonCode: XEngagementReasonCodeSchema,
  topics: z.array(XTopicLabelSchema).max(8).default([]),
  accepted: z.boolean(),
  rejectReason: z.string().max(120).optional(),
  runId: SafeIdSchema,
  decidedAt: IsoTimestampSchema,
})
export type FcEngagementDecision = z.infer<typeof FcEngagementDecisionSchema>

export const FcEngagementReceiptSchema = z.object({
  schema: z.literal(1),
  receiptId: Sha256Schema,
  actionId: Sha256Schema,
  action: z.literal("like"),
  target: FcCastHashSchema,
  attemptedAt: IsoTimestampSchema,
  verified: z.boolean(),
  ambiguous: z.boolean(),
  error: z.string().max(500).optional(),
})
export type FcEngagementReceipt = z.infer<typeof FcEngagementReceiptSchema>

export const FcEngagementFileSchema = z.object({
  schema: z.literal(1),
  likedCastHashes: z.array(FcCastHashSchema).max(50_000),
  lastLikedAt: z.record(z.string(), IsoTimestampSchema).default({}),
  pendingActionIds: z.array(Sha256Schema).max(10_000),
  decisions: z.array(FcEngagementDecisionSchema).max(100_000),
  receipts: z.array(FcEngagementReceiptSchema).max(100_000),
  daily: z.object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    likes: z.number().int().nonnegative().default(0),
  }),
})
export type FcEngagementFile = z.infer<typeof FcEngagementFileSchema>

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

export const ResearchTriggerSchema = z.enum([
  "social",
  "new-pools",
  "revisit",
  "operator",
  "narrative",
  "wallet-convergence",
])
export type ResearchTrigger = z.infer<typeof ResearchTriggerSchema>

export const ResearchQueueStatusSchema = z.enum([
  "pending",
  "ambiguous",
  "researching",
  "done",
  "expired",
  "rejected",
])
export type ResearchQueueStatus = z.infer<typeof ResearchQueueStatusSchema>

export const ResearchQueueEntrySchema = z.object({
  schema: z.literal(1),
  queueId: SafeIdSchema,
  subject: z.string().min(1).max(256),
  chain: ChainSlugSchema.optional(),
  tokenAddress: AddressSchema.optional(),
  pairAddress: AddressSchema.optional(),
  symbolDisplay: z.string().min(1).max(32).optional(),
  resolution: z.enum([
    "resolved",
    "model-confirmed",
    "ambiguous",
    "unsupported-chain",
    "pending",
  ]).default("pending"),
  priority: z.number().int().min(0).max(100),
  firstSeen: IsoTimestampSchema,
  enqueuedAt: IsoTimestampSchema,
  enqueuedBy: SafeIdSchema,
  trigger: ResearchTriggerSchema,
  expiresAt: IsoTimestampSchema,
  provenance: z.array(z.string().min(1).max(256)).max(32),
  clusterCount: z.number().int().nonnegative().default(1),
  security: z.object({
    status: z.enum(["pass", "fail", "pending"]),
    flags: z.array(z.string().min(1).max(64)).max(32).default([]),
  }).default({ status: "pending", flags: [] }),
  status: ResearchQueueStatusSchema,
  // Lease metadata for crash recovery of researching claims
  claimedAt: IsoTimestampSchema.optional(),
  attemptCount: z.number().int().nonnegative().max(32).optional(),
  revisitAfter: IsoTimestampSchema.optional(),
  reason: z.string().max(280),
})
export type ResearchQueueEntry = z.infer<typeof ResearchQueueEntrySchema>

export const ResearchQueueFileSchema = z.object({
  schema: z.literal(1),
  entries: z.array(ResearchQueueEntrySchema).max(1_000),
  completedToday: z.object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    count: z.number().int().nonnegative(),
  }).optional(),
})
export type ResearchQueueFile = z.infer<typeof ResearchQueueFileSchema>

/** Agent nomination for host research enqueue — never writes watchlist/ledger/wallets */
export const ResearchCandidateSchema = z.object({
  schema: z.literal(1),
  candidateId: SafeIdSchema,
  chain: ChainSlugSchema,
  tokenAddress: AddressSchema,
  symbolDisplay: z.string().min(1).max(32).optional(),
  evidenceRefs: z.array(z.string().min(1).max(256)).min(1).max(16),
  authors: z.array(z.string().min(1).max(128)).max(32).default([]),
  reason: z.string().min(1).max(280),
})
export type ResearchCandidate = z.infer<typeof ResearchCandidateSchema>

export const ResearchCandidateFileSchema = z.object({
  schema: z.literal(1),
  runId: SafeIdSchema,
  proposedAt: IsoTimestampSchema,
  candidates: z.array(ResearchCandidateSchema).max(8),
})
export type ResearchCandidateFile = z.infer<typeof ResearchCandidateFileSchema>

export const ResearchCandidateRejectSchema = z.object({
  candidateId: SafeIdSchema.optional(),
  reason: z.string().min(1).max(120),
})
export type ResearchCandidateReject = z.infer<typeof ResearchCandidateRejectSchema>

export const ResearchCandidateReceiptSchema = z.object({
  schema: z.literal(1),
  runId: SafeIdSchema,
  validatedAt: IsoTimestampSchema,
  accepted: z.array(z.object({
    candidateId: SafeIdSchema,
    queueId: SafeIdSchema,
    chain: ChainSlugSchema,
    tokenAddress: AddressSchema,
    clusterCount: z.number().int().nonnegative(),
  })).max(3),
  rejected: z.array(ResearchCandidateRejectSchema).max(32),
})
export type ResearchCandidateReceipt = z.infer<typeof ResearchCandidateReceiptSchema>

/** Bounded web-search requests from a network-denied research pass (host executes) */
export const WebSearchRequestSchema = z.object({
  query: z.string().min(1).max(200).regex(/^[\x20-\x7E]+$/u),
  reason: z.string().min(1).max(280),
})
export type WebSearchRequest = z.infer<typeof WebSearchRequestSchema>

export const WebSearchRequestFileSchema = z.object({
  schema: z.literal(1),
  runId: SafeIdSchema,
  requests: z.array(WebSearchRequestSchema).max(5),
})
export type WebSearchRequestFile = z.infer<typeof WebSearchRequestFileSchema>

export const WalletStatusSchema = z.enum([
  "candidate",
  "tracking-probation",
  "tracking",
  "dropped",
  "excluded",
])

export const WalletDiscoveryOriginSchema = z.enum([
  "operator-seed",
  "watchlist",
  "new-pools",
  "research",
  "fomo",
])
export type WalletDiscoveryOrigin = z.infer<typeof WalletDiscoveryOriginSchema>

export const WalletRecordSchema = z.object({
  schema: z.literal(1),
  walletId: SafeIdSchema,
  chain: ChainSlugSchema,
  address: AddressSchema,
  status: WalletStatusSchema,
  discoveredFrom: WalletDiscoveryOriginSchema.optional(),
  deterministicScore: z.number().min(0).max(1).optional(),
  llmScore: z.number().min(0).max(1).optional(),
  blendedScore: z.number().min(0).max(1).optional(),
  addedAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  lastEligibleAt: IsoTimestampSchema.optional(),
  promotedAt: IsoTimestampSchema.optional(),
  droppedAt: IsoTimestampSchema.optional(),
  cooldownUntil: IsoTimestampSchema.optional(),
  eventsAtDrop: z.number().int().nonnegative().optional(),
  hardExcluded: z.boolean().default(false),
  hardExclusionReason: z.string().max(64).optional(),
  operatorReason: z.string().max(280).optional(),
})
export type WalletRecord = z.infer<typeof WalletRecordSchema>

/** Objective hard-exclusion evidence consumed by wallet-review (host-only) */
export const WalletExclusionEvidenceSchema = z.object({
  schema: z.literal(1),
  walletId: SafeIdSchema,
  address: AddressSchema,
  chain: ChainSlugSchema,
  kind: z.string().min(1).max(64),
  evidenceHash: Sha256Schema,
  observedAt: IsoTimestampSchema,
  detail: z.string().max(280).optional(),
})
export type WalletExclusionEvidence = z.infer<typeof WalletExclusionEvidenceSchema>

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

export const WalletScanCursorSchema = z.object({
  schema: z.literal(1),
  chain: ChainSlugSchema,
  kind: z.enum([
    "token-discovery",
    "wallet-scan",
    "wallet-scan-tip",
    "wallet-scan-backfill",
    "runner-discovery",
  ]),
  subject: z.string().min(1).max(128),
  cursor: z.string().min(1).max(256),
  updatedAt: IsoTimestampSchema,
})
export type WalletScanCursor = z.infer<typeof WalletScanCursorSchema>

export const WalletBuyOutcomeSchema = z.object({
  schema: z.literal(1),
  eventId: SafeIdSchema,
  walletId: SafeIdSchema,
  chain: ChainSlugSchema,
  tokenAddress: AddressSchema,
  boughtAt: IsoTimestampSchema,
  settledAt: IsoTimestampSchema.optional(),
  excessReturn72h: z.number().optional(),
  leadTimeHours: z.number().optional(),
  maxDrawdown: z.number().min(0).max(1).optional(),
  rug: z.boolean().default(false),
  finalized: z.boolean(),
  removed: z.boolean().default(false),
  priceable: z.boolean(),
  providerEventId: z.string().min(1).max(256).optional(),
  /** Wallet status at event observation time — required for convergence */
  walletStatusAtEvent: WalletStatusSchema.optional(),
})
export type WalletBuyOutcome = z.infer<typeof WalletBuyOutcomeSchema>

export const WalletPerformanceSchema = z.object({
  effectiveBuys: z.number().int().nonnegative(),
  distinctTokens: z.number().int().nonnegative(),
  settledBuys: z.number().int().nonnegative(),
  hits: z.number().int().nonnegative(),
  coverage: z.number().min(0).max(1),
  hitMean: z.number().min(0).max(1),
  hitLb95: z.number().min(0).max(1),
  medianExcess: z.number(),
  rugExposure: z.number().min(0).max(1),
  idleDays: z.number().nonnegative(),
  leadTimeQuality: z.number().min(0).max(1),
  drawdownAndRugQuality: z.number().min(0).max(1),
  coverageDiversityActivity: z.number().min(0).max(1),
  posteriorHitQuality: z.number().min(0).max(1),
  medianExcessQuality: z.number().min(0).max(1),
  lastEligibleAt: IsoTimestampSchema.optional(),
  scoreCutoff: IsoTimestampSchema,
})
export type WalletPerformance = z.infer<typeof WalletPerformanceSchema>

export const WalletsFileSchema = z.object({
  schema: z.literal(1),
  wallets: z.array(WalletRecordSchema).max(5_000),
  transitions: z.array(WalletTransitionSchema).max(50_000).default([]),
  pendingTransitionIds: z.array(Sha256Schema).max(5_000).default([]),
  cursors: z.array(WalletScanCursorSchema).max(10_000).default([]),
  exclusions: z.array(WalletExclusionEvidenceSchema).max(5_000).optional(),
})
export type WalletsFile = z.infer<typeof WalletsFileSchema>

export const RunnerPoolRecordSchema = z.object({
  schema: z.literal(1),
  runnerId: SafeIdSchema,
  chain: ChainSlugSchema,
  poolAddress: AddressSchema,
  tokenAddress: AddressSchema,
  pairAddress: AddressSchema,
  firstSeenAt: IsoTimestampSchema,
  qualifiedAt: IsoTimestampSchema.optional(),
  rejectedReason: z.string().max(64).optional(),
  liquidityUsd: z.number().nonnegative().optional(),
  return6h: z.number().optional(),
  volume6hUsd: z.number().nonnegative().optional(),
})
export type RunnerPoolRecord = z.infer<typeof RunnerPoolRecordSchema>

export const RunnerBuyerSightingSchema = z.object({
  schema: z.literal(1),
  chain: ChainSlugSchema,
  walletAddress: AddressSchema,
  tokenAddress: AddressSchema,
  runnerId: SafeIdSchema,
  boughtAt: IsoTimestampSchema,
  providerEventId: z.string().min(1).max(256),
  blockOrSlot: z.number().int().nonnegative().optional(),
})
export type RunnerBuyerSighting = z.infer<typeof RunnerBuyerSightingSchema>

export const WalletRunnersFileSchema = z.object({
  schema: z.literal(1),
  pools: z.array(RunnerPoolRecordSchema).max(5_000).default([]),
  sightings: z.array(RunnerBuyerSightingSchema).max(50_000).default([]),
  cursors: z.array(WalletScanCursorSchema).max(10_000).default([]),
  alertedConvergenceIds: z.array(Sha256Schema).max(10_000).default([]),
  enqueuedConvergenceIds: z.array(Sha256Schema).max(10_000).default([]),
  cooldownUntilByToken: z.record(z.string(), IsoTimestampSchema).default({}),
  alertsToday: z.object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    count: z.number().int().nonnegative(),
  }).optional(),
  enqueuesToday: z.object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    count: z.number().int().nonnegative(),
  }).optional(),
})
export type WalletRunnersFile = z.infer<typeof WalletRunnersFileSchema>

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

export const AggregateRateSchema = z.object({
  numerator: z.number().nonnegative(),
  denominator: z.number().nonnegative(),
  exclusions: z.number().int().nonnegative().default(0),
  exclusionReasons: z.array(z.string()).max(32).default([]),
})

export const ScorecardSchema = z.object({
  schema: z.literal(1),
  epochId: SafeIdSchema,
  sealedAt: IsoTimestampSchema,
  manifestHash: Sha256Schema,
  paperPnlGross: z.number(),
  paperPnlCostAdjusted: z.number(),
  cohortExcess72h: AggregateRateSchema,
  hitRate: AggregateRateSchema,
  dropPrecision: AggregateRateSchema,
  ignoreMissRate: AggregateRateSchema,
  calibrationBrier: z.number().min(0).max(1).optional(),
  broadcastPrecision: AggregateRateSchema,
  sourceCallCoverage: AggregateRateSchema,
  outcomeCoverage: AggregateRateSchema,
  rugExposure: AggregateRateSchema,
  costUsd: z.number().nonnegative().default(0),
  failureCount: z.number().int().nonnegative().default(0),
})
export type Scorecard = z.infer<typeof ScorecardSchema>

export const OutcomeObservationStatusSchema = z.enum([
  "complete",
  "provider-pending",
  "censored",
  "terminal-loss",
])

export const OutcomeObservationSchema = z.object({
  schema: z.literal(1),
  subjectType: z.enum([
    "broadcast",
    "decision",
    "discovery",
    "resolution",
    "source-call",
    "wallet-buy",
  ]),
  subjectId: SafeIdSchema,
  horizonHours: z.number().int().positive(),
  observationSpecVersion: z.number().int().positive().default(1),
  status: OutcomeObservationStatusSchema,
  eventTs: IsoTimestampSchema,
  targetPrice: z.number().positive().optional(),
  benchmarkReturn: z.number().optional(),
  excessReturn: z.number().optional(),
  rawReturn: z.number().optional(),
  marketBlobHash: Sha256Schema.optional(),
  exclusionReason: z.string().max(280).optional(),
  observedAt: IsoTimestampSchema,
})
export type OutcomeObservation = z.infer<typeof OutcomeObservationSchema>

export const DecisionBundleSchema = z.object({
  schema: z.literal(1),
  decisionId: SafeIdSchema,
  runId: SafeIdSchema,
  decisionTs: IsoTimestampSchema,
  card: DecisionCardSchema,
  provenanceIds: z.array(z.string().min(1).max(256)).max(64).default([]),
  inboxManifestHash: Sha256Schema,
  sourceScoresSnapshotHash: Sha256Schema,
  marketBlobRefs: z.array(Sha256Schema).max(32).default([]),
  runConfigHash: Sha256Schema,
  policyVersion: SafeIdSchema,
  assignment: z.enum(["baseline", "candidate", "shadow"]).default("baseline"),
  gateReceiptId: Sha256Schema.optional(),
  resolutionReceiptId: Sha256Schema.optional(),
  /** Decision-time feature vector captured before outcomes; required for holdout replay */
  signals: z.record(z.number()).default({}),
})
export type DecisionBundle = z.infer<typeof DecisionBundleSchema>

/** Autonomous harness may edit exactly this path — never expands its own allowlist */
export const POLICY_ALLOWLIST_PATH = "agent/skills/decision-policy/policy.json" as const
export const DECISION_POLICY_REL_PATH = POLICY_ALLOWLIST_PATH

export const PROTECTED_QUALITY_METRICS = [
  "hitRate",
  "ignoreMissRate",
  "calibrationBrier",
  "paperPnlCostAdjusted",
  "rugExposure",
  "outcomeCoverage",
] as const
export type ProtectedQualityMetric = typeof PROTECTED_QUALITY_METRICS[number]

export const HarnessHypothesisSchema = z.object({
  schema: z.literal(1),
  hypothesisId: SafeIdSchema,
  createdAt: IsoTimestampSchema,
  epochId: SafeIdSchema,
  manifestHash: Sha256Schema,
  primaryMetric: z.string().min(1).max(64),
  safetyFloors: z.record(z.number()),
  allowlistPaths: z.array(z.string().min(1).max(256)).min(1).max(64),
  sampleRequirements: z.object({
    minEvents: z.number().int().positive(),
    minHoldoutEvents: z.number().int().positive(),
  }),
  rollbackConditions: z.array(z.string().min(1).max(280)).min(1).max(16),
  rationale: z.string().min(1).max(2_000),
  status: z.enum([
    "proposed",
    "planned",
    "plan_validated",
    "plan_approved",
    "prepared",
    "built",
    "static_validated",
    "holdout_evaluated",
    "implementation_approved",
    "committed",
    "integrated",
    "runtime_deployed",
    "activation_pending",
    "evaluated",
    "canary",
    "promoted",
    "rolled_back",
    "rejected",
  ]),
})
export type HarnessHypothesis = z.infer<typeof HarnessHypothesisSchema>

export const HarnessEvaluationSchema = z.object({
  schema: z.literal(1),
  hypothesisId: SafeIdSchema,
  evaluatedAt: IsoTimestampSchema,
  baselineCommit: z.string().min(7).max(64),
  candidateCommit: z.string().min(7).max(64),
  developmentEpochId: SafeIdSchema,
  holdoutEpochId: SafeIdSchema,
  testsPassed: z.boolean(),
  confinementPassed: z.boolean(),
  primaryImproved: z.boolean(),
  safetyFloorsPassed: z.boolean(),
  holdoutConsumed: z.boolean(),
  metrics: z.record(z.number()),
  rejectReason: z.string().max(280).optional(),
})
export type HarnessEvaluation = z.infer<typeof HarnessEvaluationSchema>

export const HarnessCanaryStateSchema = z.object({
  schema: z.literal(1),
  hypothesisId: SafeIdSchema,
  policyVersion: SafeIdSchema,
  allocationBps: z.number().int().min(0).max(10_000),
  startedAt: IsoTimestampSchema,
  stoppedAt: IsoTimestampSchema.optional(),
  stopReason: z.string().max(280).optional(),
  assignedEpisodes: z.number().int().nonnegative().default(0),
  maturePaired: z.number().int().nonnegative().default(0),
  active: z.boolean(),
})
export type HarnessCanaryState = z.infer<typeof HarnessCanaryStateSchema>

export const RunManifestSchema = z.object({
  schema: z.literal(1),
  runId: SafeIdSchema,
  job: SafeIdSchema,
  createdAt: IsoTimestampSchema,
  sealedAt: IsoTimestampSchema.optional(),
  inboxManifest: z.record(Sha256Schema).default({}),
  sourcesStartHash: Sha256Schema.optional(),
  fileHashes: z.record(Sha256Schema).default({}),
})
export type RunManifest = z.infer<typeof RunManifestSchema>

export const GateReceiptSchema = z.object({
  schema: z.literal(1),
  receiptId: Sha256Schema,
  decisionId: SafeIdSchema,
  chain: ChainSlugSchema,
  tokenAddress: AddressSchema,
  pairAddress: AddressSchema.optional(),
  status: z.enum(["pass", "hard-fail", "pending", "unsupported-chain"]),
  flags: z.array(z.string().min(1).max(64)).max(32).default([]),
  provider: z.enum(["goplus", "rugcheck", "archived", "live-refetch"]).optional(),
  rawHash: Sha256Schema.optional(),
  source: z.enum(["archived-dossier", "live-refetch"]),
  evaluatedAt: IsoTimestampSchema,
})
export type GateReceipt = z.infer<typeof GateReceiptSchema>

export const ResolutionReceiptSchema = z.object({
  schema: z.literal(1),
  receiptId: Sha256Schema,
  decisionId: SafeIdSchema,
  verdict: z.enum(["confirmed", "abstained"]),
  pickId: z.string().nullable(),
  shortlistIds: z.array(z.string()).max(32),
  validated: z.boolean(),
  evaluatedAt: IsoTimestampSchema,
})
export type ResolutionReceipt = z.infer<typeof ResolutionReceiptSchema>

export const RunIncidentSchema = z.object({
  schema: z.literal(1),
  incidentId: Sha256Schema,
  runId: SafeIdSchema,
  kind: z.enum([
    "integrity",
    "verifier",
    "budget-ceiling",
    "delivery-conflict",
    "quarantine",
    "gate",
    "alpha",
    "other",
  ]),
  message: z.string().min(1).max(500),
  details: z.record(z.unknown()).optional(),
  occurredAt: IsoTimestampSchema,
})
export type RunIncident = z.infer<typeof RunIncidentSchema>

export const PostRunVerifierCheckSchema = z.object({
  id: z.enum(["S1", "S3", "S5", "S6", "S9", "S23"]),
  passed: z.boolean(),
  detail: z.string().max(500).optional(),
})

export const PostRunVerifierReportSchema = z.object({
  schema: z.literal(1),
  runId: SafeIdSchema,
  checkedAt: IsoTimestampSchema,
  passed: z.boolean(),
  checks: z.array(PostRunVerifierCheckSchema).min(1).max(16),
})
export type PostRunVerifierReport = z.infer<typeof PostRunVerifierReportSchema>

export const AlphaKnowledgeRecordSchema = z.object({
  path: z.string().regex(/^state\/[A-Za-z0-9._/-]+$/u),
  contentHash: Sha256Schema,
})

export const AlphaDigestEntrySchema = z.object({
  provenance: z.string().min(1).max(256),
  channel: SafeIdSchema,
  messageId: SafeIdSchema,
  contentHash: Sha256Schema,
  records: z.array(AlphaKnowledgeRecordSchema).min(1).max(32),
})
export type AlphaDigestEntry = z.infer<typeof AlphaDigestEntrySchema>

export const AlphaDigestFileSchema = z.object({
  schema: z.literal(1),
  runId: SafeIdSchema,
  proposedAt: IsoTimestampSchema,
  entries: z.array(AlphaDigestEntrySchema).max(500),
})
export type AlphaDigestFile = z.infer<typeof AlphaDigestFileSchema>

export const AlphaDigestReceiptSchema = z.object({
  schema: z.literal(1),
  runId: SafeIdSchema,
  validatedAt: IsoTimestampSchema,
  accepted: z.array(AlphaDigestEntrySchema).max(500),
  rejected: z.array(z.object({
    messageId: SafeIdSchema,
    reason: z.string().max(280),
  })).max(500),
  purgedIds: z.array(SafeIdSchema).max(500),
  /** Set when the digest file exists but fails Zod or runId binding — queue untouched */
  invalidReason: z.enum(["schema-invalid", "run-id-mismatch"]).optional(),
})
export type AlphaDigestReceipt = z.infer<typeof AlphaDigestReceiptSchema>

export const ChatSummaryItemIdSchema = z.union([
  Sha256Schema,
  z.string().regex(/^item:[0-7]$/u),
])

export const ChatSummarySourcePathSchema = z.string().regex(
  /^(?:state|inbox|reports)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/u,
)

export const ChatSummaryFileSchema = z.object({
  schema: z.literal(1),
  runId: SafeIdSchema,
  proposedAt: IsoTimestampSchema,
  /** Empty when no broadcasts; when non-empty must match staged event ids */
  itemIds: z.array(ChatSummaryItemIdSchema).max(8).default([]),
  context: z.array(z.string().min(1).max(280)).min(3).max(8),
  sources: z.array(ChatSummarySourcePathSchema).min(1).max(16),
})
export type ChatSummaryFile = z.infer<typeof ChatSummaryFileSchema>

export const ChatSummaryReceiptSchema = z.object({
  schema: z.literal(1),
  runId: SafeIdSchema,
  validatedAt: IsoTimestampSchema,
  /** True when host wrote reports/chat/<run-id>.md (even without agent context) */
  promoted: z.boolean(),
  reason: z.string().max(280).optional(),
  proposalAccepted: z.boolean().optional(),
  proposalReason: z.string().max(280).optional(),
  hostOnly: z.boolean().optional(),
  itemIds: z.array(Sha256Schema).max(8).default([]),
  reportPath: z.string().max(280).optional(),
  untrustedEvidence: z.literal(true),
})
export type ChatSummaryReceipt = z.infer<typeof ChatSummaryReceiptSchema>

export const BroadcastBudgetLedgerSchema = z.object({
  schema: z.literal(1),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  used: z.number().int().nonnegative().default(0),
  urgentUsed: z.number().int().nonnegative().default(0),
  reservations: z.record(z.object({
    severity: BroadcastSeveritySchema,
    reservedAt: IsoTimestampSchema,
  })).default({}),
  updatedAt: IsoTimestampSchema,
})
export type BroadcastBudgetLedger = z.infer<typeof BroadcastBudgetLedgerSchema>

export const BroadcastRejectReceiptSchema = z.object({
  schema: z.literal(1),
  rejectId: Sha256Schema,
  runId: SafeIdSchema,
  reason: z.string().min(1).max(280),
  itemHash: Sha256Schema.optional(),
  rejectedAt: IsoTimestampSchema,
})
export type BroadcastRejectReceipt = z.infer<typeof BroadcastRejectReceiptSchema>

export const DeliveryReceiptSchema = z.object({
  schema: z.literal(1),
  receiptId: Sha256Schema,
  runId: SafeIdSchema,
  eventId: Sha256Schema,
  status: z.enum(["accepted", "duplicate", "conflict", "failed", "skipped"]),
  deliveryId: z.string().max(256).optional(),
  error: z.string().max(500).optional(),
  deliveredAt: IsoTimestampSchema,
})
export type DeliveryReceipt = z.infer<typeof DeliveryReceiptSchema>

export const SourceCallEventSchema = z.object({
  schema: z.literal(1),
  eventId: SafeIdSchema,
  sourceId: SafeIdSchema,
  provenance: z.string().min(1).max(256),
  rawAddress: AddressSchema,
  chainHint: z.enum(["evm", "solana", "unknown"]),
  mentionedAt: IsoTimestampSchema,
  parserVersion: z.number().int().positive().default(1),
  rawItemHash: Sha256Schema,
  clusterId: z.string().max(128).optional(),
  tokenId: z.string().max(256).optional(),
  pairAddress: AddressSchema.optional(),
})
export type SourceCallEvent = z.infer<typeof SourceCallEventSchema>

export const ExonerationProposalSchema = z.object({
  schema: z.literal(1),
  id: SafeIdSchema,
  sourceId: SafeIdSchema,
  provenance: z.string().min(1).max(256),
  quotedMessageHash: Sha256Schema,
  scannerFlags: z.array(z.string()).max(32),
  matchedAddress: AddressSchema,
  proposedAt: IsoTimestampSchema,
  status: z.enum(["pending", "confirmed", "undocked"]),
  intentVerdict: z.literal("warn"),
  dockSuspended: z.literal(true),
  rugAdjacencyIncremented: z.literal(true),
  resolvedAt: IsoTimestampSchema.optional(),
  resolvedBy: z.enum(["operator-telegram", "operator-cli"]).optional(),
})
export type ExonerationProposal = z.infer<typeof ExonerationProposalSchema>

export const ExonerationsFileSchema = z.object({
  schema: z.literal(1),
  proposals: z.array(ExonerationProposalSchema).max(10_000),
})
export type ExonerationsFile = z.infer<typeof ExonerationsFileSchema>

export const DecisionPolicyDocumentSchema = z.object({
  schema: z.literal(1),
  policyVersion: SafeIdSchema,
  kind: z.enum(["baseline", "candidate"]),
  createdAt: IsoTimestampSchema,
  weights: z.record(z.number()).default({}),
  thresholds: z.record(z.number()).default({}),
  rules: z.array(z.object({
    id: SafeIdSchema,
    when: z.string().min(1).max(280),
    then: z.enum(["track", "drop", "ignore", "revisit"]),
  })).max(64).default([]),
  allowlistPaths: z.array(z.string()).max(64).default([]),
})
export type DecisionPolicyDocument = z.infer<typeof DecisionPolicyDocumentSchema>

export const HarnessPlanSchema = z.object({
  schema: z.literal(1),
  hypothesisId: SafeIdSchema,
  createdAt: IsoTimestampSchema,
  model: z.string().min(1).max(128),
  baseCommit: z.string().min(7).max(64),
  developmentEpochId: SafeIdSchema,
  holdoutEpochId: SafeIdSchema,
  currentWeakness: z.string().min(1).max(2_000),
  primaryMetric: z.string().min(1).max(64),
  proposedPolicyChanges: z.string().min(1).max(4_000),
  /** Optional full document for host-side apply without a builder session */
  proposedPolicyDocument: DecisionPolicyDocumentSchema.optional(),
  expectedPrimaryEffect: z.string().min(1).max(1_000),
  expectedProtectedEffects: z.record(z.string().min(1).max(500)),
  applicableInvariants: z.array(z.string().min(1).max(64)).max(64).default([]),
  pipelineStagesAffected: z.array(z.string().min(1).max(128)).max(32).default([]),
  failureModes: z.array(z.string().min(1).max(280)).max(32).default([]),
  validationCases: z.array(z.string().min(1).max(280)).max(32).default([]),
  rollbackConditions: z.array(z.string().min(1).max(280)).min(1).max(16),
  currentPolicyHash: Sha256Schema,
  scorecardSummaryHash: Sha256Schema,
})
export type HarnessPlan = z.infer<typeof HarnessPlanSchema>

export const HarnessReviewFindingSchema = z.object({
  id: z.string().min(1).max(64),
  pass: z.boolean(),
  note: z.string().min(1).max(500),
})

export const HarnessReviewFindingsSchema = z.object({
  invariantFindings: z.array(HarnessReviewFindingSchema).max(64).default([]),
  outputQualityPass: z.boolean(),
  pipelineCompatible: z.boolean(),
  evidenceSufficient: z.boolean(),
  testCoverageAdequate: z.boolean(),
  securitySurfaceOk: z.boolean(),
  rollbackAdequate: z.boolean(),
  uncertainty: z.array(z.string().min(1).max(280)).max(16).default([]),
  rationale: z.string().min(1).max(4_000),
})

export const HarnessReviewSchema = z.object({
  schema: z.literal(1),
  hypothesisId: SafeIdSchema,
  phase: z.enum(["plan", "implementation"]),
  createdAt: IsoTimestampSchema,
  model: z.string().min(1).max(128),
  verdict: z.enum(["approve", "reject"]),
  findings: HarnessReviewFindingsSchema,
  planHash: Sha256Schema.optional(),
  evaluationHash: Sha256Schema.optional(),
  diffHash: Sha256Schema.optional(),
})
export type HarnessReview = z.infer<typeof HarnessReviewSchema>

export const HarnessRejectionReceiptSchema = z.object({
  schema: z.literal(1),
  hypothesisId: SafeIdSchema,
  rejectedAt: IsoTimestampSchema,
  phase: z.string().min(1).max(64),
  reason: z.string().min(1).max(500),
  reviewHash: Sha256Schema.optional(),
  planHash: Sha256Schema.optional(),
  evaluationHash: Sha256Schema.optional(),
})
export type HarnessRejectionReceipt = z.infer<typeof HarnessRejectionReceiptSchema>

export const AgentDeploymentFileSchema = z.object({
  relPath: z.string().min(1).max(256),
  sourceHash: Sha256Schema,
  previousHash: Sha256Schema.optional(),
})

export const AgentDeploymentManifestSchema = z.object({
  schema: z.literal(1),
  status: z.enum(["pending", "active", "failed"]),
  sourceCommit: z.string().min(7).max(64),
  hypothesisId: SafeIdSchema.optional(),
  files: z.array(AgentDeploymentFileSchema).max(256),
  createdAt: IsoTimestampSchema,
  activatedAt: IsoTimestampSchema.optional(),
  rollbackSnapshotPath: z.string().min(1).max(512).optional(),
})
export type AgentDeploymentManifest = z.infer<typeof AgentDeploymentManifestSchema>

export const HoldoutConsumptionSchema = z.object({
  schema: z.literal(1),
  epochId: SafeIdSchema,
  hypothesisId: SafeIdSchema,
  consumedAt: IsoTimestampSchema,
  candidateCommit: z.string().min(7).max(64),
})
export type HoldoutConsumption = z.infer<typeof HoldoutConsumptionSchema>

export const PairedEpisodeRecordSchema = z.object({
  schema: z.literal(1),
  episodeId: SafeIdSchema,
  runId: SafeIdSchema,
  frozenInboxHash: Sha256Schema,
  candidatePolicyVersion: SafeIdSchema,
  baselinePolicyVersion: SafeIdSchema,
  candidateProposalHash: Sha256Schema.optional(),
  baselineProposalHash: Sha256Schema.optional(),
  candidateMutated: z.boolean(),
  baselineMutated: z.literal(false),
  mature: z.boolean().default(false),
  metricDelta: z.record(z.number()).default({}),
  recordedAt: IsoTimestampSchema,
})
export type PairedEpisodeRecord = z.infer<typeof PairedEpisodeRecordSchema>

export const QuarantineConflictSchema = z.object({
  schema: z.literal(1),
  runId: SafeIdSchema,
  kind: z.enum(["phase-hash", "side-effect-hash"]),
  key: z.string().min(1).max(256),
  expected: Sha256Schema.optional(),
  observed: Sha256Schema.optional(),
  quarantinedAt: IsoTimestampSchema,
  message: z.string().min(1).max(500),
})
export type QuarantineConflict = z.infer<typeof QuarantineConflictSchema>

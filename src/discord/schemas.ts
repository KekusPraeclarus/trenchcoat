import { z } from "zod"
import { IsoTimestampSchema } from "../contracts/schemas.js"
import { GENERATED_CHAIN_SLUGS } from "../lib/chains.generated.js"

export const DiscordSnowflakeSchema = z.string().regex(/^\d{17,20}$/u)
export const DiscordChainSchema = z.enum(
  GENERATED_CHAIN_SLUGS as unknown as [string, ...string[]],
)

export const DiscordRequestStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting-chain",
  "completed",
  "failed",
  "rejected",
])

export const DiscordRequestOriginSchema = z.enum(["user", "tracking"])

export const DiscordRequestRecordSchema = z.object({
  requestId: DiscordSnowflakeSchema,
  guildId: DiscordSnowflakeSchema,
  channelId: DiscordSnowflakeSchema,
  messageId: DiscordSnowflakeSchema,
  userId: DiscordSnowflakeSchema,
  subject: z.string().min(1).max(256),
  chain: DiscordChainSchema.optional(),
  tokenAddress: z.string().min(32).max(128).optional(),
  status: DiscordRequestStatusSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  runId: z.string().max(128).optional(),
  terminalError: z.string().max(280).optional(),
  deliveredPartKeys: z.array(z.string().max(128)).max(32).default([]),
  quotaDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  /** Reserved while a chain-integration runs; released on fail or consumed on research handoff */
  chainIntegrationId: z.string().max(128).optional(),
  /** tracking-origin bypasses per-user caps; still counts server daily */
  origin: DiscordRequestOriginSchema.optional(),
  /** When set, research reply threads under this ping message */
  trackingPingMessageId: DiscordSnowflakeSchema.optional(),
  trackingId: z.string().regex(/^trk-[a-z0-9-]{8,64}$/u).optional(),
})
export type DiscordRequestRecord = z.infer<typeof DiscordRequestRecordSchema>

export const DiscordRequestsFileSchema = z.object({
  schema: z.literal(1),
  requests: z.array(DiscordRequestRecordSchema).max(5_000),
  dailyByUser: z.record(z.string(), z.number().int().min(0)).default({}),
  dailyServer: z.number().int().min(0).default(0),
  quotaDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
})
export type DiscordRequestsFile = z.infer<typeof DiscordRequestsFileSchema>

export const DiscordSubscriptionSchema = z.object({
  guildId: DiscordSnowflakeSchema,
  userId: DiscordSnowflakeSchema,
  channelId: DiscordSnowflakeSchema,
  messageId: DiscordSnowflakeSchema,
  startedAt: IsoTimestampSchema,
  renewedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
})
export type DiscordSubscription = z.infer<typeof DiscordSubscriptionSchema>

export const DiscordWatchTokenSchema = z.object({
  chain: DiscordChainSchema,
  tokenAddress: z.string().min(32).max(128),
  symbolDisplay: z.string().max(32).optional(),
  /** Truncated thesis from the research reply — monitor update writer context */
  researchBrief: z.string().max(1200).optional(),
  subscriptions: z.array(DiscordSubscriptionSchema).max(500),
  lastNotifiedAt: IsoTimestampSchema.optional(),
})
export type DiscordWatchToken = z.infer<typeof DiscordWatchTokenSchema>

export const DiscordWatchlistFileSchema = z.object({
  schema: z.literal(1),
  tokens: z.array(DiscordWatchTokenSchema).max(2_000),
})
export type DiscordWatchlistFile = z.infer<typeof DiscordWatchlistFileSchema>

export const DiscordObservationSchema = z.object({
  observedAt: IsoTimestampSchema,
  priceUsd: z.number().nullable(),
  liquidityUsd: z.number().nullable(),
  volume24hUsd: z.number().nullable(),
  fdvUsd: z.number().nullable(),
  buys24h: z.number().nullable(),
  sells24h: z.number().nullable(),
  securityStatus: z.string().max(64).nullable(),
  securityFlags: z.array(z.string().max(64)).max(32),
  xPostCount: z.number().int().nullable(),
  xAuthorCount: z.number().int().nullable(),
  xRecentCount: z.number().int().nullable(),
  xKnownLikes: z.number().int().nullable(),
  xKnownViews: z.number().int().nullable(),
  xKnownReplies: z.number().int().nullable(),
  xKnownReposts: z.number().int().nullable(),
  xAuthorIds: z.array(z.string().max(64)).max(200).default([]),
})
export type DiscordObservation = z.infer<typeof DiscordObservationSchema>

export const DiscordObservationsFileSchema = z.object({
  schema: z.literal(1),
  byToken: z.record(z.string(), DiscordObservationSchema).default({}),
})
export type DiscordObservationsFile = z.infer<typeof DiscordObservationsFileSchema>

export const DiscordDeliveryStatusSchema = z.enum([
  "pending",
  "delivered",
  "failed",
])

export const DiscordDeliveryRecordSchema = z.object({
  deliveryId: z.string().min(8).max(128),
  kind: z.enum(["research", "watch-update", "chain-integration", "tracking-ping"]),
  requestId: DiscordSnowflakeSchema.optional(),
  chain: z.string().min(1).max(64).optional(),
  tokenAddress: z.string().min(32).max(128).optional(),
  channelId: DiscordSnowflakeSchema,
  anchorMessageId: DiscordSnowflakeSchema,
  mentionUserIds: z.array(DiscordSnowflakeSchema).max(99).default([]),
  parts: z.array(z.string().max(2_000)).max(16),
  deliveredPartKeys: z.array(z.string().max(128)).max(32).default([]),
  status: DiscordDeliveryStatusSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  observationKey: z.string().max(128).optional(),
  trackingId: z.string().regex(/^trk-[a-z0-9-]{8,64}$/u).optional(),
})
export type DiscordDeliveryRecord = z.infer<typeof DiscordDeliveryRecordSchema>

export const TrackingRequestStatusSchema = z.enum([
  "active",
  "pending-capacity",
  "tentative",
  "expired-awaiting-reply",
  "expired-final",
  "dropped",
])
export type TrackingRequestStatus = z.infer<typeof TrackingRequestStatusSchema>

export const TrackingIdSchema = z.string().regex(/^trk-[a-z0-9-]{8,64}$/u)

export const TrackingRequestRecordSchema = z.object({
  trackingId: TrackingIdSchema,
  guildId: DiscordSnowflakeSchema,
  channelId: DiscordSnowflakeSchema,
  messageId: DiscordSnowflakeSchema,
  userId: DiscordSnowflakeSchema,
  description: z.string().min(1).max(500),
  shortLabel: z.string().min(1).max(64),
  status: TrackingRequestStatusSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  extensionCount: z.number().int().min(0).max(100).default(0),
  /** Derived from delivered/terminal deliveries; retained for fast allowlist checks */
  matchedSubjects: z.array(z.string().min(1).max(256)).max(500).default([]),
  expiryNoticeMessageId: DiscordSnowflakeSchema.optional(),
  /** When pending-capacity / tentative silently expire */
  pendingExpiresAt: IsoTimestampSchema.optional(),
})
export type TrackingRequestRecord = z.infer<typeof TrackingRequestRecordSchema>

export const TrackingMatchSourceKindSchema = z.enum([
  "list-scan",
  "farcaster-scan",
  "research",
  "discord-research",
])
export type TrackingMatchSourceKind = z.infer<typeof TrackingMatchSourceKindSchema>

export const TrackingMatchBatchStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
])

export const TrackingMatchBatchSchema = z.object({
  batchId: z.string().min(8).max(128),
  sourceKind: TrackingMatchSourceKindSchema,
  runId: z.string().min(1).max(128),
  snapshotHash: z.string().min(8).max(128),
  status: TrackingMatchBatchStatusSchema,
  attemptCount: z.number().int().min(0).max(32).default(0),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  nextAttemptAt: IsoTimestampSchema.optional(),
  claimedAt: IsoTimestampSchema.optional(),
  lastError: z.string().max(280).optional(),
  /** Host-captured candidate payload summary for the matcher (path or inline digest) */
  candidateDigest: z.string().min(1).max(64_000),
  researchSummary: z.string().max(8_000).optional(),
  researchSubject: z.string().max(256).optional(),
})
export type TrackingMatchBatch = z.infer<typeof TrackingMatchBatchSchema>

export const TrackingDeliveryStatusSchema = z.enum([
  "pending",
  "sending",
  "delivered",
  "terminal",
])

export const TrackingDeliveryRecordSchema = z.object({
  deliveryId: z.string().min(8).max(128),
  trackingId: TrackingIdSchema,
  subject: z.string().min(1).max(256),
  normalizedSubject: z.string().min(1).max(256),
  reason: z.string().min(1).max(200),
  status: TrackingDeliveryStatusSchema,
  guildId: DiscordSnowflakeSchema,
  channelId: DiscordSnowflakeSchema,
  userId: DiscordSnowflakeSchema,
  anchorMessageId: DiscordSnowflakeSchema,
  parts: z.array(z.string().max(2_000)).max(16),
  deliveredPartKeys: z.array(z.string().max(128)).max(32).default([]),
  discordMessageIds: z.array(DiscordSnowflakeSchema).max(16).default([]),
  attemptCount: z.number().int().min(0).max(32).default(0),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  lastError: z.string().max(280).optional(),
  batchId: z.string().min(8).max(128),
  sourceKind: TrackingMatchSourceKindSchema,
  /** When true, enqueue tracking-origin research after ping */
  needsResearch: z.boolean().default(false),
  researchEnqueued: z.boolean().default(false),
  researchSummary: z.string().max(8_000).optional(),
  pingMessageId: DiscordSnowflakeSchema.optional(),
})
export type TrackingDeliveryRecord = z.infer<typeof TrackingDeliveryRecordSchema>

export const DiscordTrackingFileSchema = z.object({
  schema: z.literal(1),
  requests: z.array(TrackingRequestRecordSchema).max(5_000),
  matchBatches: z.array(TrackingMatchBatchSchema).max(5_000).default([]),
  trackingDeliveries: z.array(TrackingDeliveryRecordSchema).max(10_000).default([]),
})
export type DiscordTrackingFile = z.infer<typeof DiscordTrackingFileSchema>

export const DiscordDeliveriesFileSchema = z.object({
  schema: z.literal(1),
  deliveries: z.array(DiscordDeliveryRecordSchema).max(2_000),
})
export type DiscordDeliveriesFile = z.infer<typeof DiscordDeliveriesFileSchema>

export const DiscordHeartbeatSchema = z.object({
  schema: z.literal(1),
  pid: z.number().int(),
  updatedAt: IsoTimestampSchema,
  lastError: z.string().max(500).optional(),
})
export type DiscordHeartbeat = z.infer<typeof DiscordHeartbeatSchema>

export const DiscordMonitorCursorSchema = z.object({
  schema: z.literal(1),
  scanStartedAt: IsoTimestampSchema,
  tokenIndex: z.number().int().min(0),
})
export type DiscordMonitorCursor = z.infer<typeof DiscordMonitorCursorSchema>

export function tokenKey(chain: string, tokenAddress: string): string {
  return `${chain}:${tokenAddress.toLowerCase()}`
}

import { z } from "zod"
import { IsoTimestampSchema, Sha256Schema } from "../contracts/schemas.js"
import { DiscordSnowflakeSchema } from "../discord/schemas.js"
import { ChainManifestSchema } from "../lib/chain-manifest.js"

export const ChainIntegrationPhaseSchema = z.enum([
  "queued",
  "collecting",
  "researched",
  "prepared",
  "building",
  "finalizing",
  "gated",
  "committed",
  "pushed",
  "deploying",
  "deployed",
  "announced",
  "research_queued",
  "completed",
  "failed",
])
export type ChainIntegrationPhase = z.infer<typeof ChainIntegrationPhaseSchema>

export const ChainIntegrationSourceSchema = z.object({
  guildId: DiscordSnowflakeSchema,
  channelId: DiscordSnowflakeSchema,
  messageId: DiscordSnowflakeSchema,
  userId: DiscordSnowflakeSchema,
  subject: z.string().min(1).max(256),
  tokenAddress: z.string().min(32).max(128),
  reservedQuota: z.boolean().default(true),
  reacted: z.boolean().default(false),
  announced: z.boolean().default(false),
  researchEnqueued: z.boolean().default(false),
})
export type ChainIntegrationSource = z.infer<typeof ChainIntegrationSourceSchema>

export const ChainIntegrationRecordSchema = z.object({
  integrationId: z.string().min(8).max(128),
  slug: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/u),
  phase: ChainIntegrationPhaseSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  quotaDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  sources: z.array(ChainIntegrationSourceSchema).min(1).max(50),
  baseCommit: z.string().max(64).optional(),
  candidateCommit: z.string().max(64).optional(),
  worktreePath: z.string().max(512).optional(),
  branch: z.string().max(128).optional(),
  displayName: z.string().max(64).optional(),
  manifestHash: Sha256Schema.optional(),
  gateHash: Sha256Schema.optional(),
  repairRound: z.number().int().min(0).max(8).default(0),
  providerAttempts: z.number().int().min(0).max(20).default(0),
  deployAttempts: z.number().int().min(0).max(5).default(0),
  terminalError: z.string().max(280).optional(),
  workerPid: z.number().int().optional(),
})
export type ChainIntegrationRecord = z.infer<typeof ChainIntegrationRecordSchema>

export const ChainIntegrationsFileSchema = z.object({
  schema: z.literal(1),
  integrations: z.array(ChainIntegrationRecordSchema).max(500),
  attemptsByDay: z.record(z.string(), z.number().int().min(0)).default({}),
  activeIntegrationId: z.string().max(128).nullable().default(null),
})
export type ChainIntegrationsFile = z.infer<typeof ChainIntegrationsFileSchema>

export const ChainResearchProposalSchema = z.object({
  schema: z.literal(1),
  manifest: ChainManifestSchema,
  requestedToken: z.string().min(32).max(128),
  requestedPair: z.string().min(32).max(128).optional(),
  confidence: z.number().int().min(0).max(100),
  uncertainty: z.array(z.string().max(280)).max(16),
  evidencePaths: z.array(z.string().max(512)).max(32),
})
export type ChainResearchProposal = z.infer<typeof ChainResearchProposalSchema>

export const ChainFinalReviewSchema = z.object({
  schema: z.literal(1),
  verdict: z.enum(["approve", "reject"]),
  findings: z.object({
    evidenceSufficient: z.boolean(),
    testCoverageAdequate: z.boolean(),
    securitySurfaceOk: z.boolean(),
    rollbackAdequate: z.boolean(),
    docsUpdated: z.boolean(),
    uncertainty: z.array(z.string().max(280)).max(16),
  }),
})
export type ChainFinalReview = z.infer<typeof ChainFinalReviewSchema>

export const ACTIVE_INTEGRATION_PHASES = [
  "queued",
  "collecting",
  "researched",
  "prepared",
  "building",
  "finalizing",
  "gated",
  "committed",
  "pushed",
  "deploying",
  "deployed",
  "announced",
  "research_queued",
] as const satisfies readonly ChainIntegrationPhase[]

import { z } from "zod"

export const RemediationPhaseSchema = z.enum([
  "detected",
  "triaged",
  "diagnosing",
  "diagnosed",
  "proposing",
  "proposed",
  "pre-reviewing",
  "pre-reviewed",
  "awaiting-approval",
  "approved",
  "deferred",
  "rejected",
  "building",
  "built",
  "post-reviewing",
  "post-reviewed",
  "gating",
  "gated",
  "publishing",
  "deploying",
  "deployed",
  "awaiting-recovery-data",
  "collecting-revalidation",
  "revalidating",
  "reconciling-state",
  "correcting",
  "attention-required",
  "rolling-back",
  "rolled-back",
  "completed",
  "failed",
  "ignored",
])
export type RemediationPhase = z.infer<typeof RemediationPhaseSchema>

export const ACTIVE_REMEDIATION_PHASES = new Set<RemediationPhase>([
  "detected",
  "triaged",
  "diagnosing",
  "diagnosed",
  "proposing",
  "proposed",
  "pre-reviewing",
  "pre-reviewed",
  "awaiting-approval",
  "approved",
  "building",
  "built",
  "post-reviewing",
  "post-reviewed",
  "gating",
  "gated",
  "publishing",
  "deploying",
  "awaiting-recovery-data",
  "collecting-revalidation",
  "revalidating",
  "reconciling-state",
  "correcting",
  "rolling-back",
])

export const TriageVerdictSchema = z.enum([
  "ignore",
  "attention-now",
  "defer-weekly",
])
export type TriageVerdict = z.infer<typeof TriageVerdictSchema>

export const RiskLevelSchema = z.enum(["low", "high", "deny"])
export type RiskLevel = z.infer<typeof RiskLevelSchema>

export const ReviewDecisionSchema = z.enum(["approve", "revise", "reject"])
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>

export const UntrustedEvidenceSchema = z.object({
  schema: z.literal(1),
  trust: z.literal("untrusted-external"),
  kind: z.enum([
    "log-line",
    "journal",
    "skip",
    "health",
    "heartbeat",
    "discord-suggestion",
    "other",
  ]),
  path: z.string().min(1).max(512).optional(),
  summary: z.string().min(1).max(500),
  capturedAt: z.string().min(1).max(64),
})
export type UntrustedEvidence = z.infer<typeof UntrustedEvidenceSchema>

export const SuggestionCategorySchema = z.enum([
  "bug-fix",
  "small-feature",
  "docs",
  "ops-tuning",
])
export type SuggestionCategory = z.infer<typeof SuggestionCategorySchema>

export const RemediationIncidentSchema = z.object({
  schema: z.literal(1),
  incidentId: z.string().min(8).max(128),
  fingerprint: z.string().min(8).max(128),
  phase: RemediationPhaseSchema,
  createdAt: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
  job: z.string().min(1).max(64).optional(),
  component: z.string().min(1).max(64).optional(),
  errorClass: z.string().min(1).max(128).optional(),
  title: z.string().min(1).max(280),
  severity: z.enum(["info", "warn", "error"]).default("warn"),
  origin: z.enum([
    "health",
    "log",
    "skip",
    "discord-suggestion",
    "other",
  ]).optional(),
  suggestionThreadId: z.string().min(1).max(128).optional(),
  extendsIncidentId: z.string().min(8).max(128).optional(),
  suggestionCategory: SuggestionCategorySchema.optional(),
  alternativesConsidered: z.array(z.string().max(200)).max(5).optional(),
  recommendationRationale: z.string().max(500).optional(),
  triageVerdict: TriageVerdictSchema.optional(),
  triageReason: z.string().max(500).optional(),
  riskLevel: RiskLevelSchema.optional(),
  riskReasons: z.array(z.string().max(200)).max(32).optional(),
  proposalHash: z.string().min(8).max(128).optional(),
  approvalExpiresAt: z.string().min(1).max(64).optional(),
  approvedAt: z.string().min(1).max(64).optional(),
  approvedBy: z.string().min(1).max(64).optional(),
  baseSha: z.string().min(7).max(64).optional(),
  candidateSha: z.string().min(7).max(64).optional(),
  branch: z.string().min(1).max(128).optional(),
  worktreePath: z.string().min(1).max(512).optional(),
  attemptCount: z.number().int().min(0).max(20).default(0),
  originMoveRebuilds: z.number().int().min(0).max(5).default(0),
  /** Completed pre-review revise → re-propose cycles (caps at config max) */
  preReviewReviseCount: z.number().int().min(0).max(20).default(0),
  deferredAt: z.string().min(1).max(64).optional(),
  deferredReason: z.string().max(500).optional(),
  terminalError: z.string().max(500).optional(),
  evidencePaths: z.array(z.string().max(512)).max(32).default([]),
  proposedPaths: z.array(z.string().max(512)).max(64).optional(),
  smokeChecks: z.array(z.string().max(64)).max(16).optional(),
  affectedSources: z.array(z.string().min(1).max(64)).max(32).optional(),
  affectedJobs: z.array(z.string().min(1).max(64)).max(32).optional(),
  impactWindowStart: z.string().min(1).max(64).optional(),
  impactWindowEnd: z.string().min(1).max(64).optional(),
  deployedAt: z.string().min(1).max(64).optional(),
  recoveryConfirmedAt: z.string().min(1).max(64).optional(),
  revalidationRound: z.number().int().min(0).max(20).optional(),
  revalidationRunId: z.string().min(1).max(128).optional(),
  correctionEventIds: z.array(z.string().min(1).max(128)).max(16).optional(),
  attentionReason: z.string().max(500).optional(),
})
export type RemediationIncident = z.infer<typeof RemediationIncidentSchema>

export const RemediationsFileSchema = z.object({
  schema: z.literal(1),
  incidents: z.array(RemediationIncidentSchema).max(500),
  attemptsByDay: z.record(z.string(), z.number().int().min(0).max(100)),
  activeIncidentId: z.string().min(8).max(128).nullable(),
  lastScanAt: z.string().min(1).max(64).optional(),
  lastWeeklyAt: z.string().min(1).max(64).optional(),
  automationHalted: z.boolean().default(false),
  automationHaltReason: z.string().max(500).optional(),
})
export type RemediationsFile = z.infer<typeof RemediationsFileSchema>

export const LogCursorSchema = z.object({
  path: z.string().min(1).max(512),
  inode: z.string().min(1).max(64).optional(),
  size: z.number().int().min(0),
  offset: z.number().int().min(0),
  updatedAt: z.string().min(1).max(64),
})
export type LogCursor = z.infer<typeof LogCursorSchema>

export const RemediationCursorsFileSchema = z.object({
  schema: z.literal(1),
  logs: z.array(LogCursorSchema).max(128),
  lastTransactionName: z.string().max(256).optional(),
  lastSkipOffsets: z.record(z.string(), z.number().int().min(0)).default({}),
  /** Per Discord channelId → last consumed message snowflake */
  discordChannelCursors: z.record(z.string(), z.string().regex(/^\d{17,20}$/u)).default({}),
  /** Pending page checkpoint before cursor advance (crash resume) */
  discordScanCheckpoint: z.object({
    channelId: z.string().regex(/^\d{17,20}$/u),
    after: z.string().regex(/^\d{17,20}$/u).optional(),
    lastMessageId: z.string().regex(/^\d{17,20}$/u).optional(),
    updatedAt: z.string().min(1).max(64),
  }).optional(),
  suggestionClassifierFailures: z.number().int().min(0).max(10).default(0),
  lastSuggestionDigestDay: z.string().max(16).optional(),
})
export type RemediationCursorsFile = z.infer<typeof RemediationCursorsFileSchema>

export const DeferredQueueFileSchema = z.object({
  schema: z.literal(1),
  incidentIds: z.array(z.string().min(8).max(128)).max(200),
})
export type DeferredQueueFile = z.infer<typeof DeferredQueueFileSchema>

export const TriageResultSchema = z.object({
  schema: z.literal(1),
  verdict: TriageVerdictSchema,
  reason: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1),
  intendedCapability: z.string().max(128).optional(),
  reproducible: z.boolean().optional(),
})
export type TriageResult = z.infer<typeof TriageResultSchema>

export const DiagnosisReportSchema = z.object({
  schema: z.literal(1),
  symptom: z.string().min(1).max(500),
  intendedBehavior: z.string().min(1).max(500),
  rootCause: z.string().min(1).max(1_000),
  reproduction: z.string().min(1).max(500),
  affectedFiles: z.array(z.string().max(512)).max(32).default([]),
  securityImplications: z.string().min(1).max(500),
  successCriteria: z.string().min(1).max(500),
  evidenceRefs: z.array(z.string().max(512)).max(32).default([]),
  viable: z.boolean().optional(),
  notViableReason: z.string().max(500).optional(),
})
export type DiagnosisReport = z.infer<typeof DiagnosisReportSchema>

export const PatchProposalSchema = z.object({
  schema: z.literal(1),
  // Host-truncate: propose models often emit prose past short-field bounds
  summary: z.string().min(1).transform((s) => s.slice(0, 500)),
  paths: z.array(z.string().min(1).max(512)).max(32).default([]),
  perFileChanges: z.array(z.object({
    path: z.string().min(1).max(512),
    change: z.string().min(1).max(1_000),
  })).max(32).default([]),
  tests: z.array(z.string().max(280)).max(32).default([]),
  invariants: z.array(z.string().transform((s) => s.slice(0, 64))).max(32).default([]),
  docs: z.array(z.string().max(512)).max(16).default([]),
  typedMigration: z.string().max(280).optional(),
  rollout: z.string().transform((s) => s.slice(0, 500)).default("n/a"),
  smokeChecks: z.array(z.string().transform((s) => s.slice(0, 64))).max(16).default([]),
  rollback: z.string().transform((s) => s.slice(0, 500)).default("n/a"),
  viable: z.boolean().optional(),
  notViableReason: z.string().transform((s) => s.slice(0, 500)).optional(),
})
export type PatchProposal = z.infer<typeof PatchProposalSchema>

export const RemediationReviewSchema = z.object({
  schema: z.literal(1),
  decision: ReviewDecisionSchema,
  concerns: z.array(z.string().max(500)).max(32).default([]),
  uncertainty: z.array(z.string().max(500)).max(16).default([]),
  securitySurfaceOk: z.boolean(),
  confinementOk: z.boolean(),
  testsAdequate: z.boolean(),
  docsAdequate: z.boolean(),
  notes: z.string().max(1_000).optional(),
})
export type RemediationReview = z.infer<typeof RemediationReviewSchema>

export const GateResultSchema = z.object({
  schema: z.literal(1),
  ok: z.boolean(),
  steps: z.array(z.object({
    name: z.string().min(1).max(64),
    ok: z.boolean(),
    detail: z.string().max(500).optional(),
  })).max(32),
})
export type GateResult = z.infer<typeof GateResultSchema>

export const DeploymentReceiptSchema = z.object({
  schema: z.literal(1),
  sourceCommit: z.string().min(7).max(64),
  sourceDirty: z.boolean(),
  configSchema: z.number().int(),
  deployedAt: z.string().min(1).max(64),
  healthOk: z.boolean(),
  smokeOk: z.boolean(),
  detail: z.string().max(500).optional(),
})
export type DeploymentReceipt = z.infer<typeof DeploymentReceiptSchema>

export const ApprovalActionSchema = z.enum(["approve", "defer", "reject"])
export type ApprovalAction = z.infer<typeof ApprovalActionSchema>

export const SourceHealthStatusSchema = z.enum(["healthy", "unhealthy", "unknown"])
export type SourceHealthStatus = z.infer<typeof SourceHealthStatusSchema>

export const SourceHealthObservationSchema = z.object({
  schema: z.literal(1),
  observationId: z.string().min(8).max(128),
  sourceKind: z.string().min(1).max(64),
  target: z.string().min(1).max(128),
  observedAt: z.string().min(1).max(64),
  status: SourceHealthStatusSchema,
  postCount: z.number().int().min(0).max(100_000).optional(),
  hitCursor: z.boolean().optional(),
  challenged: z.boolean().optional(),
  pagesScrolled: z.number().int().min(0).max(1_000).optional(),
  runId: z.string().min(1).max(128).optional(),
  roundId: z.string().min(1).max(128).optional(),
  sourceCommit: z.string().min(7).max(64).optional(),
  reason: z.string().max(280).optional(),
})
export type SourceHealthObservation = z.infer<typeof SourceHealthObservationSchema>

export const SourceHealthLedgerSchema = z.object({
  schema: z.literal(1),
  observations: z.array(SourceHealthObservationSchema).max(5_000),
})
export type SourceHealthLedger = z.infer<typeof SourceHealthLedgerSchema>

export const ClaimVerdictSchema = z.enum(["stands", "invalidated", "inconclusive"])
export type ClaimVerdict = z.infer<typeof ClaimVerdictSchema>

export const ClaimRevalidationResultSchema = z.object({
  schema: z.literal(1),
  claimId: z.string().min(8).max(128),
  verdict: ClaimVerdictSchema,
  reason: z.string().min(1).max(1_000),
  evidenceRefs: z.array(z.string().max(512)).max(32).default([]),
  evaluatorNotes: z.string().max(1_000).optional(),
  reviewerNotes: z.string().max(1_000).optional(),
  uncertainty: z.array(z.string().max(500)).max(16).default([]),
})
export type ClaimRevalidationResult = z.infer<typeof ClaimRevalidationResultSchema>

export const ImpactWindowSchema = z.object({
  schema: z.literal(1),
  ok: z.boolean(),
  startExclusive: z.string().min(1).max(64).optional(),
  endInclusive: z.string().min(1).max(64).optional(),
  reason: z.string().max(280).optional(),
})
export type ImpactWindow = z.infer<typeof ImpactWindowSchema>

export const SuggestionOutcomeSchema = z.enum([
  "not-eligible",
  "already-scanned",
  "duplicate-suggestion",
  "no-suggestion-signal",
  "classifier-failed",
  "classifier-exhausted",
  "not-buildable",
  "forming",
  "formation-expired",
  "suggestion-formed",
  "out-of-scope",
  "deny-surface",
  "capacity",
  "queued-waiting",
  "duplicate-incident",
  "queued",
  "not-viable",
  "built",
])
export type SuggestionOutcome = z.infer<typeof SuggestionOutcomeSchema>

export const SuggestionLedgerEntrySchema = z.object({
  schema: z.literal(1),
  entryId: z.string().min(8).max(128),
  threadId: z.string().min(1).max(128),
  channelId: z.string().regex(/^\d{17,20}$/u),
  contentFingerprint: z.string().min(8).max(64),
  outcome: SuggestionOutcomeSchema,
  reason: z.string().max(500).optional(),
  humanMessageIds: z.array(z.string().regex(/^\d{17,20}$/u)).max(200).default([]),
  allMessageIds: z.array(z.string().regex(/^\d{17,20}$/u)).max(400).default([]),
  participantIds: z.array(z.string().regex(/^\d{17,20}$/u)).max(100).default([]),
  category: SuggestionCategorySchema.optional(),
  summary: z.string().max(500).optional(),
  confidence: z.number().min(0).max(1).optional(),
  /** Formed decision contract (INV-S27): what hurts, what should happen, how we check */
  symptom: z.string().max(500).optional(),
  intendedBehavior: z.string().max(500).optional(),
  acceptanceCriteria: z.array(z.string().max(280)).max(5).optional(),
  alternativesConsidered: z.array(z.string().max(200)).max(5).optional(),
  recommendationRationale: z.string().max(500).optional(),
  formingNote: z.string().max(500).optional(),
  formingRounds: z.number().int().min(0).max(20).default(0),
  /** One clarifying question per suggestion, asked in the Discord thread (ADR 025) */
  followupMessageId: z.string().regex(/^\d{17,20}$/u).optional(),
  followupAskedAt: z.string().min(1).max(64).optional(),
  extendsIncidentId: z.string().min(8).max(128).optional(),
  incidentId: z.string().min(8).max(128).optional(),
  evidencePath: z.string().max(512).optional(),
  createdAt: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
  lastActivityAt: z.string().min(1).max(64),
})
export type SuggestionLedgerEntry = z.infer<typeof SuggestionLedgerEntrySchema>

export const SuggestionLedgerFileSchema = z.object({
  schema: z.literal(1),
  entries: z.array(SuggestionLedgerEntrySchema).max(5_000),
  queuedWaiting: z.array(z.object({
    entryId: z.string().min(8).max(128),
    enqueuedAt: z.string().min(1).max(64),
  })).max(200).default([]),
})
export type SuggestionLedgerFile = z.infer<typeof SuggestionLedgerFileSchema>

export const SuggestionClassifierThreadResultSchema = z.object({
  threadId: z.string().min(1).max(128),
  verdict: z.enum(["suggestion-formed", "forming", "not-buildable"]),
  category: SuggestionCategorySchema.optional(),
  summary: z.string().max(500).optional(),
  contributingMessageIds: z.array(z.string().regex(/^\d{17,20}$/u)).max(50).optional(),
  confidence: z.number().min(0).max(1).optional(),
  symptom: z.string().max(500).optional(),
  intendedBehavior: z.string().max(500).optional(),
  acceptanceCriteria: z.array(z.string().max(280)).max(5).optional(),
  alternativesConsidered: z.array(z.string().max(200)).max(5).optional(),
  recommendationRationale: z.string().max(500).optional(),
  formingNote: z.string().max(500).optional(),
  /** Untrusted classifier text — sanitize before it reaches Discord */
  followupQuestion: z.string().max(300).optional(),
})
export type SuggestionClassifierThreadResult = z.infer<
  typeof SuggestionClassifierThreadResultSchema
>

export const SuggestionClassifierBatchSchema = z.object({
  schema: z.literal(1),
  threads: z.array(SuggestionClassifierThreadResultSchema).max(50),
})
export type SuggestionClassifierBatch = z.infer<typeof SuggestionClassifierBatchSchema>

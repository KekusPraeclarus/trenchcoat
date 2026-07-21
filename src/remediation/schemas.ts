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
  kind: z.enum(["log-line", "journal", "skip", "health", "heartbeat", "other"]),
  path: z.string().min(1).max(512).optional(),
  summary: z.string().min(1).max(500),
  capturedAt: z.string().min(1).max(64),
})
export type UntrustedEvidence = z.infer<typeof UntrustedEvidenceSchema>

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
  deferredAt: z.string().min(1).max(64).optional(),
  deferredReason: z.string().max(500).optional(),
  terminalError: z.string().max(500).optional(),
  evidencePaths: z.array(z.string().max(512)).max(32).default([]),
  proposedPaths: z.array(z.string().max(512)).max(64).optional(),
  smokeChecks: z.array(z.string().max(64)).max(16).optional(),
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
  affectedFiles: z.array(z.string().max(512)).min(1).max(32),
  securityImplications: z.string().min(1).max(500),
  successCriteria: z.string().min(1).max(500),
  evidenceRefs: z.array(z.string().max(512)).max(32).default([]),
})
export type DiagnosisReport = z.infer<typeof DiagnosisReportSchema>

export const PatchProposalSchema = z.object({
  schema: z.literal(1),
  summary: z.string().min(1).max(500),
  paths: z.array(z.string().min(1).max(512)).min(1).max(32),
  perFileChanges: z.array(z.object({
    path: z.string().min(1).max(512),
    change: z.string().min(1).max(1_000),
  })).min(1).max(32),
  tests: z.array(z.string().max(280)).min(1).max(32),
  invariants: z.array(z.string().max(64)).max(32).default([]),
  docs: z.array(z.string().max(512)).max(16).default([]),
  typedMigration: z.string().max(280).optional(),
  rollout: z.string().min(1).max(500),
  smokeChecks: z.array(z.string().max(64)).min(1).max(16),
  rollback: z.string().min(1).max(500),
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

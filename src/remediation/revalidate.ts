/**
 * Post-fix claim revalidation (INV-S28).
 * Fail-closed: no verdict/mutation/egress without fresh sealed post-fix evidence
 * and unanimous evaluator+reviewer agreement for invalidation.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { writeAtomicFileFsync } from "../lib/fs-atomic.js"
import type { MarketClaimRecord } from "../orchestrator/market-claims.js"
import {
  CLAIM_REVALIDATE_PROMPT,
  CLAIM_REVALIDATE_REVIEW_PROMPT,
} from "../prompts/host.js"
import type { ClaimRevalidationResult, ClaimVerdict } from "./schemas.js"
import { ClaimRevalidationResultSchema } from "./schemas.js"

export const CLAIM_EVALUATE_PROMPT = CLAIM_REVALIDATE_PROMPT
export const CLAIM_REVIEW_PROMPT = CLAIM_REVALIDATE_REVIEW_PROMPT
const AgentVerdictSchema = z.object({
  schema: z.literal(1),
  claimId: z.string().min(8).max(128),
  verdict: z.enum(["stands", "invalidated", "inconclusive"]),
  reason: z.string().min(1).max(1_000),
  evidenceRefs: z.array(z.string().max(512)).max(32).default([]),
  evaluatorNotes: z.string().max(1_000).optional(),
  reviewerNotes: z.string().max(1_000).optional(),
  uncertainty: z.array(z.string().max(500)).max(16).default([]),
})

export type RevalidationSessionRunner = (
  args: Readonly<{ prompt: string; message: string }>,
) => Promise<string>

function stripFence(raw: string): string {
  let text = raw.trim()
  if (text.startsWith("```") && text.endsWith("```")) {
    text = text.replace(/^```(?:\w+)?\n?/u, "").replace(/\n?```$/u, "").trim()
  }
  return text
}

export function assertEvidenceFetchedAfter(
  evidencePaths: readonly string[],
  deployedAt: string,
  readTs: (path: string) => string | undefined = defaultReadFetchedAt,
): { ok: true } | { ok: false; reason: string } {
  const deployedMs = Date.parse(deployedAt)
  if (!Number.isFinite(deployedMs)) return { ok: false, reason: "invalid-deployed-at" }
  for (const path of evidencePaths) {
    const ts = readTs(path)
    if (!ts) return { ok: false, reason: `missing-fetchedAt:${path}` }
    const ms = Date.parse(ts)
    if (!Number.isFinite(ms) || ms <= deployedMs) {
      return { ok: false, reason: `stale-or-pre-fix:${path}` }
    }
  }
  return { ok: true }
}

function defaultReadFetchedAt(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      fetchedAt?: string
      items?: Array<{ ts?: string }>
    }
    if (typeof raw.fetchedAt === "string") return raw.fetchedAt
    const first = raw.items?.[0]?.ts
    return typeof first === "string" ? first : undefined
  } catch {
    return undefined
  }
}

export function citationsAllowlisted(
  cited: readonly string[],
  allowlist: ReadonlySet<string>,
): boolean {
  if (cited.length === 0) return false
  return cited.every((c) => allowlist.has(c))
}

/**
 * Deterministic contradiction helpers where available.
 * Returns true when host can prove the claim no longer holds.
 */
/** True when host has a claim-specific contradiction check for this kind. */
export function hasDeterministicCheck(claim: MarketClaimRecord): boolean {
  return claim.kind === "narrative-stage"
    || claim.auditClaimType === "narrative-fade"
}

export function deterministicContradiction(args: Readonly<{
  claim: MarketClaimRecord
  currentNarrativeStage?: "emerging" | "peaking" | "fading"
}>): boolean {
  if (args.claim.kind === "narrative-stage" || args.claim.auditClaimType === "narrative-fade") {
    if (args.claim.narrativeStage === "fading" || args.claim.auditClaimType === "narrative-fade") {
      return args.currentNarrativeStage === "peaking"
        || args.currentNarrativeStage === "emerging"
    }
    if (args.claim.narrativeStage === "peaking") {
      return args.currentNarrativeStage === "fading"
    }
  }
  return false
}

export function mergeVerdicts(args: Readonly<{
  claimId: string
  evaluator: ClaimRevalidationResult
  reviewer: ClaimRevalidationResult
  deterministicInvalidated: boolean
  /** When true, automatic invalidation also requires deterministicContradiction */
  deterministicAvailable?: boolean
  allowlist: ReadonlySet<string>
}>): ClaimRevalidationResult {
  const evalOk = citationsAllowlisted(args.evaluator.evidenceRefs, args.allowlist)
    || args.evaluator.verdict === "inconclusive"
  const revOk = citationsAllowlisted(args.reviewer.evidenceRefs, args.allowlist)
    || args.reviewer.verdict === "inconclusive"

  if (!evalOk || !revOk) {
    return ClaimRevalidationResultSchema.parse({
      schema: 1,
      claimId: args.claimId,
      verdict: "inconclusive",
      reason: "citation-not-allowlisted",
      evidenceRefs: [],
      uncertainty: ["citation-gate"],
    })
  }

  const detGateOk = !args.deterministicAvailable || args.deterministicInvalidated

  if (
    args.evaluator.verdict === "invalidated"
    && args.reviewer.verdict === "invalidated"
    && args.evaluator.uncertainty.length === 0
    && args.reviewer.uncertainty.length === 0
    && detGateOk
  ) {
    return ClaimRevalidationResultSchema.parse({
      schema: 1,
      claimId: args.claimId,
      verdict: "invalidated",
      reason: args.evaluator.reason,
      evidenceRefs: [...new Set([
        ...args.evaluator.evidenceRefs,
        ...args.reviewer.evidenceRefs,
      ])].slice(0, 32),
      uncertainty: [],
      ...(args.evaluator.evaluatorNotes
        ? { evaluatorNotes: args.evaluator.evaluatorNotes }
        : {}),
      ...(args.reviewer.reviewerNotes
        ? { reviewerNotes: args.reviewer.reviewerNotes }
        : {}),
    })
  }

  if (
    args.evaluator.verdict === "stands"
    && args.reviewer.verdict === "stands"
    && args.evaluator.uncertainty.length === 0
    && args.reviewer.uncertainty.length === 0
  ) {
    return ClaimRevalidationResultSchema.parse({
      schema: 1,
      claimId: args.claimId,
      verdict: "stands",
      reason: args.evaluator.reason,
      evidenceRefs: [...args.evaluator.evidenceRefs].slice(0, 32),
      uncertainty: [],
    })
  }

  return ClaimRevalidationResultSchema.parse({
    schema: 1,
    claimId: args.claimId,
    verdict: "inconclusive",
    reason: "evaluator-reviewer-disagreement-or-uncertainty",
    evidenceRefs: [],
    uncertainty: [
      ...args.evaluator.uncertainty,
      ...args.reviewer.uncertainty,
      `eval=${args.evaluator.verdict}`,
      `rev=${args.reviewer.verdict}`,
      ...(args.deterministicAvailable && !args.deterministicInvalidated
        ? ["no-deterministic-contradiction"]
        : []),
    ].slice(0, 16),
  })
}

export async function runClaimEvaluator(args: Readonly<{
  claim: MarketClaimRecord
  allowlistedEvidence: readonly string[]
  evidenceDigest: string
  runSession: RevalidationSessionRunner
  prompt?: string
}>): Promise<{ ok: true; result: ClaimRevalidationResult } | { ok: false; reason: string }> {
  try {
    const raw = await args.runSession({
      prompt: args.prompt ?? CLAIM_EVALUATE_PROMPT,
      message: [
        `claimId=${args.claim.claimId}`,
        `kind=${args.claim.kind}`,
        `subject=${args.claim.subject}`,
        `summary=${args.claim.summary}`,
        `allowlistedEvidence=${args.allowlistedEvidence.join(",")}`,
        "<untrusted-evidence>",
        args.evidenceDigest.slice(0, 8_000),
        "</untrusted-evidence>",
      ].join("\n"),
    })
    const parsed = AgentVerdictSchema.safeParse(JSON.parse(stripFence(raw)))
    if (!parsed.success) return { ok: false, reason: "schema-invalid" }
    if (parsed.data.claimId !== args.claim.claimId) {
      return { ok: false, reason: "claim-id-mismatch" }
    }
    return {
      ok: true,
      result: ClaimRevalidationResultSchema.parse({
        ...parsed.data,
        evaluatorNotes: parsed.data.evaluatorNotes ?? parsed.data.reason,
      }),
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message.slice(0, 120) : "session-error",
    }
  }
}

export async function runClaimReviewer(args: Readonly<{
  claim: MarketClaimRecord
  evaluator: ClaimRevalidationResult
  allowlistedEvidence: readonly string[]
  evidenceDigest: string
  runSession: RevalidationSessionRunner
  prompt?: string
}>): Promise<{ ok: true; result: ClaimRevalidationResult } | { ok: false; reason: string }> {
  try {
    const raw = await args.runSession({
      prompt: args.prompt ?? CLAIM_REVIEW_PROMPT,
      message: [
        `claimId=${args.claim.claimId}`,
        `evaluatorVerdict=${args.evaluator.verdict}`,
        `evaluatorReason=${args.evaluator.reason}`,
        `allowlistedEvidence=${args.allowlistedEvidence.join(",")}`,
        "<untrusted-evidence>",
        args.evidenceDigest.slice(0, 8_000),
        "</untrusted-evidence>",
      ].join("\n"),
    })
    const parsed = AgentVerdictSchema.safeParse(JSON.parse(stripFence(raw)))
    if (!parsed.success) return { ok: false, reason: "schema-invalid" }
    if (parsed.data.claimId !== args.claim.claimId) {
      return { ok: false, reason: "claim-id-mismatch" }
    }
    return {
      ok: true,
      result: ClaimRevalidationResultSchema.parse({
        ...parsed.data,
        reviewerNotes: parsed.data.reviewerNotes ?? parsed.data.reason,
      }),
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message.slice(0, 120) : "session-error",
    }
  }
}

export async function writeRevalidationArtifact(args: Readonly<{
  artifactDir: string
  results: readonly ClaimRevalidationResult[]
}>): Promise<string> {
  const path = join(args.artifactDir, "revalidation.json")
  await writeAtomicFileFsync(
    path,
    `${JSON.stringify({ schema: 1, results: args.results }, null, 2)}\n`,
    0o600,
  )
  return path
}

export function summarizeVerdicts(
  results: readonly ClaimRevalidationResult[],
): Readonly<{
  stands: number
  invalidated: number
  inconclusive: number
}> {
  let stands = 0
  let invalidated = 0
  let inconclusive = 0
  for (const r of results) {
    if (r.verdict === "stands") stands += 1
    else if (r.verdict === "invalidated") invalidated += 1
    else inconclusive += 1
  }
  return { stands, invalidated, inconclusive }
}

export type { ClaimVerdict }

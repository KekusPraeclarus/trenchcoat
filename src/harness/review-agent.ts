import { join } from "node:path"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { sha256Json } from "../lib/canonical-json.js"
import {
  HarnessReviewSchema,
  type HarnessReview,
} from "../contracts/schemas.js"
import { HARNESS_REVIEW_PROMPT } from "../prompts/host.js"
import {
  runOneShotSession,
  type SessionOptions,
  type SessionResult,
} from "../orchestrator/session.js"
import { hypothesisDir } from "./propose.js"
import { extractJsonObject } from "./parse-json.js"

export type ReviewSessionFn = (opts: SessionOptions) => Promise<SessionResult>

export type RunHarnessReviewOpts = Readonly<{
  archiveRoot: string
  hypothesisId: string
  repoRoot: string
  phase: "plan" | "implementation"
  model: string
  nowIso: string
  artifactPaths: readonly string[]
  planHash?: `sha256:${string}`
  evaluationHash?: `sha256:${string}`
  diffHash?: `sha256:${string}`
  runSession?: ReviewSessionFn
}>

export type ReviewAgentResult =
  | Readonly<{ ok: true, review: HarnessReview, reviewHash: `sha256:${string}` }>
  | Readonly<{ ok: false, reason: string }>

export type ReviewApproval =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false, reason: string }>

function buildReviewPrompt(args: Readonly<{
  phase: "plan" | "implementation"
  artifactPaths: readonly string[]
}>): string {
  return [
    HARNESS_REVIEW_PROMPT,
    "",
    `phase=${args.phase}`,
    "Host-supplied artifact paths only:",
    ...args.artifactPaths.map((p) => `artifact=${p}`),
  ].join("\n")
}

function parseReview(
  text: string,
  defaults: Readonly<{
    hypothesisId: string
    phase: "plan" | "implementation"
    createdAt: string
    model: string
    planHash?: `sha256:${string}`
    evaluationHash?: `sha256:${string}`
    diffHash?: `sha256:${string}`
  }>,
): HarnessReview {
  const raw = extractJsonObject(text)
  const merged = {
    schema: 1,
    ...(typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {}),
    hypothesisId: defaults.hypothesisId,
    phase: defaults.phase,
    createdAt: defaults.createdAt,
    model: defaults.model,
    ...(defaults.planHash ? { planHash: defaults.planHash } : {}),
    ...(defaults.evaluationHash ? { evaluationHash: defaults.evaluationHash } : {}),
    ...(defaults.diffHash ? { diffHash: defaults.diffHash } : {}),
  }
  return HarnessReviewSchema.parse(merged)
}

/** Host gate: reviewer cannot waive deterministic failures elsewhere */
export function validateReviewApproval(review: HarnessReview): ReviewApproval {
  if (review.verdict !== "approve") {
    return { ok: false, reason: "reviewer rejected" }
  }
  const f = review.findings
  if (!f.outputQualityPass) return { ok: false, reason: "outputQualityPass false" }
  if (!f.pipelineCompatible) return { ok: false, reason: "pipelineCompatible false" }
  if (!f.evidenceSufficient) return { ok: false, reason: "evidenceSufficient false" }
  if (!f.testCoverageAdequate) return { ok: false, reason: "testCoverageAdequate false" }
  if (!f.securitySurfaceOk) return { ok: false, reason: "securitySurfaceOk false" }
  if (!f.rollbackAdequate) return { ok: false, reason: "rollbackAdequate false" }
  if (f.uncertainty.length > 0) {
    return { ok: false, reason: "uncertainty not empty" }
  }
  for (const finding of f.invariantFindings) {
    if (!finding.pass) {
      return { ok: false, reason: `invariant ${finding.id} failed` }
    }
  }
  return { ok: true }
}

export async function runHarnessReview(
  opts: RunHarnessReviewOpts,
): Promise<ReviewAgentResult> {
  const dir = hypothesisDir(opts.archiveRoot, opts.hypothesisId)
  const prompt = buildReviewPrompt({
    phase: opts.phase,
    artifactPaths: opts.artifactPaths,
  })
  const runSession = opts.runSession ?? runOneShotSession
  const sessionOpts: SessionOptions = {
    prompt,
    cwd: opts.repoRoot,
    model: opts.model,
    sandbox: true,
    mode: "ask",
  }

  const defaults = {
    hypothesisId: opts.hypothesisId,
    phase: opts.phase,
    createdAt: opts.nowIso,
    model: opts.model,
    ...(opts.planHash ? { planHash: opts.planHash } : {}),
    ...(opts.evaluationHash ? { evaluationHash: opts.evaluationHash } : {}),
    ...(opts.diffHash ? { diffHash: opts.diffHash } : {}),
  }

  let session = await runSession(sessionOpts)
  if (session.status !== "finished" || !session.text) {
    return { ok: false, reason: session.error ?? "review session failed" }
  }

  let review: HarnessReview
  try {
    review = parseReview(session.text, defaults)
  } catch (firstError) {
    const repairPrompt = [
      prompt,
      "",
      "Previous output was malformed. Return one valid JSON review object only.",
      firstError instanceof Error ? firstError.message : String(firstError),
    ].join("\n")
    session = await runSession({ ...sessionOpts, prompt: repairPrompt })
    if (session.status !== "finished" || !session.text) {
      return { ok: false, reason: "review repair session failed" }
    }
    try {
      review = parseReview(session.text, defaults)
    } catch (secondError) {
      return {
        ok: false,
        reason: secondError instanceof Error
          ? `review malformed after repair: ${secondError.message}`
          : "review malformed after repair",
      }
    }
  }

  const fileName = opts.phase === "plan"
    ? "plan-review.json"
    : "implementation-review.json"
  await writeAtomicFile(
    join(dir, fileName),
    `${JSON.stringify(review, null, 2)}\n`,
    0o600,
  )
  const reviewHash = sha256Json(review as never)
  return { ok: true, review, reviewHash }
}

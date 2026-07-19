import { join } from "node:path"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { sha256Json } from "../lib/canonical-json.js"
import {
  HarnessPlanSchema,
  type HarnessPlan,
} from "../contracts/schemas.js"
import { HARNESS_PLAN_PROMPT } from "../prompts/host.js"
import {
  runOneShotSession,
  type SessionOptions,
  type SessionResult,
} from "../orchestrator/session.js"
import { hypothesisDir, loadHypothesis, saveHypothesis } from "./propose.js"
import { extractJsonObject } from "./parse-json.js"
import { DECISION_POLICY_REL_PATH } from "./paths.js"

export type PlanSessionFn = (opts: SessionOptions) => Promise<SessionResult>

export type RunHarnessPlannerOpts = Readonly<{
  archiveRoot: string
  hypothesisId: string
  repoRoot: string
  model: string
  baseCommit: string
  developmentEpochId: string
  holdoutEpochId: string
  nowIso: string
  runSession?: PlanSessionFn
}>

export type PlanAgentResult =
  | Readonly<{ ok: true, plan: HarnessPlan, planHash: `sha256:${string}` }>
  | Readonly<{ ok: false, reason: string }>

function buildPlanPrompt(args: Readonly<{
  scorecardSummaryPath: string
  policyPath: string
  docsPaths: readonly string[]
}>): string {
  return [
    HARNESS_PLAN_PROMPT,
    "",
    "Host-supplied paths only:",
    `scorecardSummary=${args.scorecardSummaryPath}`,
    `currentPolicy=${args.policyPath}`,
    ...args.docsPaths.map((p) => `doc=${p}`),
  ].join("\n")
}

function parsePlan(
  text: string,
  defaults: Readonly<{
    hypothesisId: string
    createdAt: string
    model: string
    baseCommit: string
    developmentEpochId: string
    holdoutEpochId: string
  }>,
): HarnessPlan {
  const raw = extractJsonObject(text)
  const merged = {
    schema: 1,
    ...(typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {}),
    hypothesisId: defaults.hypothesisId,
    createdAt: defaults.createdAt,
    model: defaults.model,
    baseCommit: defaults.baseCommit,
    developmentEpochId: defaults.developmentEpochId,
    holdoutEpochId: defaults.holdoutEpochId,
  }
  return HarnessPlanSchema.parse(merged)
}

export async function runHarnessPlanner(
  opts: RunHarnessPlannerOpts,
): Promise<PlanAgentResult> {
  const hypothesis = loadHypothesis(opts.archiveRoot, opts.hypothesisId)
  const dir = hypothesisDir(opts.archiveRoot, opts.hypothesisId)
  const scorecardSummaryPath = join(dir, "scorecard-summary.json")
  const policyPath = join(opts.repoRoot, DECISION_POLICY_REL_PATH)
  const docsPaths = [
    join(opts.repoRoot, "docs/architecture/harness-improvement.md"),
    join(opts.repoRoot, "docs/INVARIANTS.md"),
  ]

  const prompt = buildPlanPrompt({
    scorecardSummaryPath,
    policyPath,
    docsPaths,
  })
  const runSession = opts.runSession ?? runOneShotSession
  const sessionOpts: SessionOptions = {
    prompt,
    cwd: opts.repoRoot,
    model: opts.model,
    sandbox: true,
    mode: "plan",
  }

  const defaults = {
    hypothesisId: opts.hypothesisId,
    createdAt: opts.nowIso,
    model: opts.model,
    baseCommit: opts.baseCommit,
    developmentEpochId: opts.developmentEpochId,
    holdoutEpochId: opts.holdoutEpochId,
  }

  let session = await runSession(sessionOpts)
  if (session.status !== "finished" || !session.text) {
    return { ok: false, reason: session.error ?? "planner session failed" }
  }

  let plan: HarnessPlan
  try {
    plan = parsePlan(session.text, defaults)
  } catch (firstError) {
    const repairPrompt = [
      prompt,
      "",
      "Previous output was malformed. Return one valid JSON plan object only.",
      firstError instanceof Error ? firstError.message : String(firstError),
    ].join("\n")
    session = await runSession({ ...sessionOpts, prompt: repairPrompt })
    if (session.status !== "finished" || !session.text) {
      return { ok: false, reason: "planner repair session failed" }
    }
    try {
      plan = parsePlan(session.text, defaults)
    } catch (secondError) {
      return {
        ok: false,
        reason: secondError instanceof Error
          ? `planner malformed after repair: ${secondError.message}`
          : "planner malformed after repair",
      }
    }
  }

  if (plan.hypothesisId !== hypothesis.hypothesisId) {
    return { ok: false, reason: "plan hypothesisId mismatch" }
  }
  if (plan.primaryMetric !== hypothesis.primaryMetric) {
    return { ok: false, reason: "plan primaryMetric mismatch" }
  }

  await writeAtomicFile(
    join(dir, "plan.json"),
    `${JSON.stringify(plan, null, 2)}\n`,
    0o600,
  )
  await saveHypothesis(opts.archiveRoot, { ...hypothesis, status: "planned" })
  const planHash = sha256Json(plan as never)
  return { ok: true, plan, planHash }
}

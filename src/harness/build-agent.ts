import { existsSync, lstatSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import {
  DecisionPolicyDocumentSchema,
  HarnessPlanSchema,
  type DecisionPolicyDocument,
  type HarnessPlan,
} from "../contracts/schemas.js"
import { HARNESS_BUILD_PROMPT } from "../prompts/host.js"
import {
  runOneShotSession,
  type SessionOptions,
  type SessionResult,
} from "../orchestrator/session.js"
import { loadHypothesis, saveHypothesis, hypothesisDir } from "./propose.js"
import { evaluateWorktreeConfinement, readWorktreeMeta } from "./prepare.js"
import { savePolicy } from "./policy.js"
import { extractJsonObject } from "./parse-json.js"
import { DECISION_POLICY_REL_PATH, POLICY_ALLOWLIST } from "./paths.js"

export type BuildSessionFn = (opts: SessionOptions) => Promise<SessionResult>

export type RunHarnessBuilderOpts = Readonly<{
  archiveRoot: string
  hypothesisId: string
  repoRoot: string
  model: string
  nowIso: string
  runSession?: BuildSessionFn
  runTests?: boolean
}>

export type BuildAgentResult =
  | Readonly<{ ok: true, policy: DecisionPolicyDocument }>
  | Readonly<{ ok: false, reason: string, terminal?: boolean }>

function loadPlan(archiveRoot: string, hypothesisId: string): HarnessPlan {
  const path = join(hypothesisDir(archiveRoot, hypothesisId), "plan.json")
  return HarnessPlanSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

function rejectSymlinkOrSpecial(policyAbs: string): string | undefined {
  if (!existsSync(policyAbs)) return "policy file missing after build"
  const st = lstatSync(policyAbs)
  if (st.isSymbolicLink()) return "policy path is a symlink"
  if (!st.isFile()) return "policy path is not a regular file"
  return undefined
}

function parsePolicyFromText(text: string): DecisionPolicyDocument {
  return DecisionPolicyDocumentSchema.parse(extractJsonObject(text))
}

async function writeAndValidatePolicy(
  worktreePath: string,
  repoRoot: string,
  doc: DecisionPolicyDocument,
): Promise<{ ok: true, policy: DecisionPolicyDocument } | { ok: false, reason: string, terminal: boolean }> {
  const allowlist = [...POLICY_ALLOWLIST]
  if (doc.allowlistPaths.length > 0) {
    const expanded = doc.allowlistPaths.some((p) => p !== DECISION_POLICY_REL_PATH)
    if (expanded) {
      return { ok: false, reason: "policy allowlistPaths expanded beyond decision-policy", terminal: true }
    }
  }
  const forced: DecisionPolicyDocument = {
    ...doc,
    allowlistPaths: [DECISION_POLICY_REL_PATH],
    kind: "candidate",
  }
  const policyAbs = join(worktreePath, DECISION_POLICY_REL_PATH)
  await savePolicy(policyAbs, forced)

  const special = rejectSymlinkOrSpecial(policyAbs)
  if (special) return { ok: false, reason: special, terminal: true }

  const confinement = evaluateWorktreeConfinement({
    worktreePath,
    allowlist,
    repoRoot,
  })
  if (!confinement.ok) {
    return {
      ok: false,
      reason: `confinement: ${confinement.violations.join(",")}`,
      terminal: true,
    }
  }
  return { ok: true, policy: forced }
}

function runUnitTests(worktreePath: string): boolean {
  const test = spawnSync("pnpm", ["test:unit"], {
    cwd: worktreePath,
    encoding: "utf8",
    timeout: 120_000,
  })
  return test.status === 0
}

export async function runHarnessBuilder(
  opts: RunHarnessBuilderOpts,
): Promise<BuildAgentResult> {
  const hypothesis = loadHypothesis(opts.archiveRoot, opts.hypothesisId)
  if (
    hypothesis.status !== "plan_approved"
    && hypothesis.status !== "prepared"
    && hypothesis.status !== "built"
  ) {
    return { ok: false, reason: `builder requires plan_approved (got ${hypothesis.status})`, terminal: true }
  }

  const plan = loadPlan(opts.archiveRoot, opts.hypothesisId)
  const meta = readWorktreeMeta(opts.archiveRoot, opts.hypothesisId)
  const runSession = opts.runSession ?? runOneShotSession

  let applied: DecisionPolicyDocument | undefined

  if (plan.proposedPolicyDocument) {
    const result = await writeAndValidatePolicy(
      meta.worktreePath,
      opts.repoRoot,
      plan.proposedPolicyDocument,
    )
    if (!result.ok) return result
    applied = result.policy
  } else {
    const prompt = [
      HARNESS_BUILD_PROMPT,
      "",
      `planPath=${join(hypothesisDir(opts.archiveRoot, opts.hypothesisId), "plan.json")}`,
      `policyPath=${join(meta.worktreePath, DECISION_POLICY_REL_PATH)}`,
      `proposedPolicyChanges follows in plan file — emit full DecisionPolicyDocument JSON only.`,
    ].join("\n")
    const sessionOpts: SessionOptions = {
      prompt,
      cwd: meta.worktreePath,
      model: opts.model,
      sandbox: true,
    }
    let session = await runSession(sessionOpts)
    if (session.status !== "finished" || !session.text) {
      return { ok: false, reason: session.error ?? "builder session failed", terminal: false }
    }
    try {
      const doc = parsePolicyFromText(session.text)
      const result = await writeAndValidatePolicy(meta.worktreePath, opts.repoRoot, doc)
      if (!result.ok) {
        if (result.terminal) return result
      } else {
        applied = result.policy
      }
    } catch (firstError) {
      const repairPrompt = [
        prompt,
        "",
        "Previous policy JSON was invalid. Emit one valid DecisionPolicyDocument JSON only.",
        firstError instanceof Error ? firstError.message : String(firstError),
      ].join("\n")
      session = await runSession({ ...sessionOpts, prompt: repairPrompt })
      if (session.status !== "finished" || !session.text) {
        return { ok: false, reason: "builder repair session failed", terminal: false }
      }
      try {
        const doc = parsePolicyFromText(session.text)
        const result = await writeAndValidatePolicy(meta.worktreePath, opts.repoRoot, doc)
        if (!result.ok) return result
        applied = result.policy
      } catch (secondError) {
        return {
          ok: false,
          reason: secondError instanceof Error
            ? `builder malformed after repair: ${secondError.message}`
            : "builder malformed after repair",
          terminal: false,
        }
      }
    }
  }

  if (!applied) {
    return { ok: false, reason: "builder produced no policy", terminal: false }
  }

  if (opts.runTests !== false) {
    let testsOk = runUnitTests(meta.worktreePath)
    if (!testsOk && plan.proposedPolicyDocument === undefined) {
      // One repair attempt for schema/test failures that stay inside the plan
      const repairPrompt = [
        HARNESS_BUILD_PROMPT,
        "",
        "Unit tests failed after the previous policy write. Emit a corrected DecisionPolicyDocument JSON only.",
        `planPath=${join(hypothesisDir(opts.archiveRoot, opts.hypothesisId), "plan.json")}`,
      ].join("\n")
      const session = await runSession({
        prompt: repairPrompt,
        cwd: meta.worktreePath,
        model: opts.model,
        sandbox: true,
      })
      if (session.status === "finished" && session.text) {
        try {
          const doc = parsePolicyFromText(session.text)
          const result = await writeAndValidatePolicy(meta.worktreePath, opts.repoRoot, doc)
          if (result.ok) {
            applied = result.policy
            testsOk = runUnitTests(meta.worktreePath)
          } else if (result.terminal) {
            return result
          }
        } catch {
          // fall through to test failure
        }
      }
    }
    if (!testsOk) {
      return { ok: false, reason: "unit tests failed after build", terminal: false }
    }
  }

  await saveHypothesis(opts.archiveRoot, { ...hypothesis, status: "built" })
  return { ok: true, policy: applied }
}

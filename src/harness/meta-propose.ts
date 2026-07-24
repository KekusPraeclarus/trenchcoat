import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  HarnessImproverConfigSchema,
  MetaCandidateSchema,
  type HarnessImproverConfig,
  type MetaCandidate,
} from "../contracts/schemas.js"
import { systemClock } from "../lib/clock.js"
import { loadConfig } from "../lib/config.js"
import {
  DEFAULT_IMPROVER_CONFIG,
  improverConfigHash,
  loadImproverConfig,
  saveImproverConfig,
} from "./improver-config.js"
import {
  buildPriorAttemptsSummary,
  ensurePriorAttemptsIndex,
} from "./prior-attempts.js"
import {
  IMPROVER_CONFIG_ALLOWLIST,
  IMPROVER_CONFIG_REL_PATH,
} from "./paths.js"
import { confineDiff, evaluateWorktreeConfinement } from "./prepare.js"
import {
  commitCandidateBranch,
  fastForwardLocalMain,
} from "./integrate.js"
import {
  listMetaCandidateIds,
  listTrials,
  loadCandidateImproverConfig,
  loadMetaCandidate,
  loadUtility,
  metaCandidateDir,
  recomputeAndSaveUtility,
  saveCandidateImproverConfig,
  saveMetaCandidate,
} from "./meta-trial.js"
import { META_MIN_VALID_PAIRS } from "./meta-utility.js"
import { assertRepoRoot } from "./pr.js"
import { loadMetaOperatorNotifyReceipt } from "./meta-operator-notify.js"

/**
 * Shadow meta-lane propose (ADR 039).
 * Persists candidate.json + candidate-config.json. Never writes active policy.
 */
export function proposeMetaCandidate(opts: Readonly<{
  repoRoot: string
  candidateId: string
  nowIso: string
  rationale: string
  candidateConfig: HarnessImproverConfig
}>): MetaCandidate {
  const baseline = loadImproverConfig(opts.repoRoot)
  return MetaCandidateSchema.parse({
    schema: 1,
    candidateId: opts.candidateId,
    createdAt: opts.nowIso,
    baseConfigHash: improverConfigHash(baseline),
    candidateConfigHash: improverConfigHash(opts.candidateConfig),
    status: "proposed",
    rationale: opts.rationale.slice(0, 1_000),
  })
}

export async function persistMetaCandidate(opts: Readonly<{
  archiveRoot: string
  candidate: MetaCandidate
  candidateConfig: HarnessImproverConfig
}>): Promise<MetaCandidate> {
  await saveCandidateImproverConfig(
    opts.archiveRoot,
    opts.candidate.candidateId,
    opts.candidateConfig,
  )
  await saveMetaCandidate(opts.archiveRoot, opts.candidate)
  return opts.candidate
}

function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)))
}

/**
 * Host-deterministic candidate: tweak mining knobs within schema bounds from
 * prior-attempt aggregates (e.g. raise minClusterSize when many thin failures).
 */
export async function proposeMetaCandidateFromPrior(opts: Readonly<{
  archiveRoot: string
  repoRoot: string
  nowIso?: string
  candidateId?: string
}>): Promise<MetaCandidate> {
  const nowIso = opts.nowIso ?? systemClock.nowIso()
  await ensurePriorAttemptsIndex(opts.archiveRoot)
  const prior = buildPriorAttemptsSummary(opts.archiveRoot, {
    nowIso,
    maxRecords: 64,
  })
  const baseline = loadImproverConfig(opts.repoRoot)
  const mining = { ...baseline.mining }
  const propose = {
    ...baseline.propose,
    weakMetricPriority: { ...baseline.propose.weakMetricPriority },
  }

  const holdoutFails = prior.records.filter(
    (r) => r.resultClass === "holdout-fail" || r.reasonCode === "holdout-fail",
  ).length
  const reviewRejects = prior.records.filter(
    (r) => r.resultClass === "review-reject" || r.reasonCode === "review-reject",
  ).length
  const thinPatternSignal = holdoutFails + reviewRejects

  const rationaleParts: string[] = []
  if (thinPatternSignal >= 3) {
    const next = clampInt(mining.minClusterSize + 1, 3, 20)
    if (next !== mining.minClusterSize) {
      rationaleParts.push(
        `Raised minClusterSize ${mining.minClusterSize}→${next} after ${thinPatternSignal} thin/failed prior attempts`,
      )
      mining.minClusterSize = next
    }
    const nextMax = clampInt(mining.maxClusters - 1, 1, 8)
    if (nextMax !== mining.maxClusters && mining.maxClusters > 1) {
      rationaleParts.push(
        `Lowered maxClusters ${mining.maxClusters}→${nextMax} to prefer denser patterns`,
      )
      mining.maxClusters = nextMax
    }
  } else if (prior.count === 0) {
    rationaleParts.push(
      "No prior attempts — slight maxEvidencePerPattern bump for denser mining evidence",
    )
    mining.maxEvidencePerPattern = clampInt(
      mining.maxEvidencePerPattern + 2,
      1,
      32,
    )
  } else {
    rationaleParts.push(
      `Prior attempts=${prior.count} without thin-pattern signal — nudge maxKeepPatterns`,
    )
    mining.maxKeepPatterns = clampInt(mining.maxKeepPatterns + 1, 1, 3)
  }

  // Prefer hitRate slightly more when many holdout fails cite track quality
  if (holdoutFails >= 2) {
    const hit = propose.weakMetricPriority["hitRate"] ?? 1
    propose.weakMetricPriority["hitRate"] = Math.min(2, hit + 0.1)
    rationaleParts.push("Bumped hitRate weakMetricPriority after holdout fails")
  }

  const candidateConfig = HarnessImproverConfigSchema.parse({
    ...DEFAULT_IMPROVER_CONFIG,
    ...baseline,
    mining,
    propose,
    planAddendum: baseline.planAddendum,
  })

  let finalConfig = candidateConfig
  if (improverConfigHash(candidateConfig) === improverConfigHash(baseline)) {
    // Force a bounded schema-valid delta so the candidate is distinct
    const forcedSize = clampInt(mining.minClusterSize + 1, 3, 20)
    finalConfig = HarnessImproverConfigSchema.parse({
      ...candidateConfig,
      mining: { ...candidateConfig.mining, minClusterSize: forcedSize },
    })
    rationaleParts.push(
      `Forced minClusterSize→${forcedSize} for distinct candidate hash`,
    )
  }

  const digest = createHash("sha256")
    .update(`${improverConfigHash(finalConfig)}:${nowIso}`)
    .digest("hex")
    .slice(0, 16)
  const candidateId = opts.candidateId ?? `mc-${digest}`
  const candidate = proposeMetaCandidate({
    repoRoot: opts.repoRoot,
    candidateId,
    nowIso,
    rationale: rationaleParts.join(". ").slice(0, 1_000) || "meta mining knob tweak",
    candidateConfig: finalConfig,
  })
  await persistMetaCandidate({
    archiveRoot: opts.archiveRoot,
    candidate,
    candidateConfig: finalConfig,
  })
  return candidate
}

export async function setMetaCandidateStatus(opts: Readonly<{
  archiveRoot: string
  candidateId: string
  status: MetaCandidate["status"]
}>): Promise<MetaCandidate> {
  const current = loadMetaCandidate(opts.archiveRoot, opts.candidateId)
  const updated = MetaCandidateSchema.parse({ ...current, status: opts.status })
  await saveMetaCandidate(opts.archiveRoot, updated)
  return updated
}

export async function rejectMetaCandidate(opts: Readonly<{
  archiveRoot: string
  candidateId: string
  nowIso?: string
}>): Promise<MetaCandidate> {
  return setMetaCandidateStatus({
    archiveRoot: opts.archiveRoot,
    candidateId: opts.candidateId,
    status: "rejected",
  })
}

function gitRevParse(repoRoot: string): string {
  const out = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  const sha = (out.stdout ?? "").trim()
  if (out.status !== 0 || sha.length < 7) {
    throw new Error(`git rev-parse HEAD failed in ${repoRoot}`)
  }
  return sha
}

function git(
  cwd: string,
  args: readonly string[],
): { status: number, stdout: string, stderr: string } {
  const out = spawnSync("git", [...args], { cwd, encoding: "utf8" })
  return {
    status: out.status ?? 1,
    stdout: (out.stdout ?? "").trim(),
    stderr: (out.stderr ?? "").trim(),
  }
}

/**
 * Operator-only promotion: write improver config via meta worktree, confine,
 * commit, ff-only integrate. Never agent sync / canary / deploy.
 */
export async function promoteMetaCandidate(opts: Readonly<{
  archiveRoot: string
  repoRoot: string
  candidateId: string
  nowIso?: string
  pushOrigin?: boolean
}>): Promise<Readonly<{
  ok: true
  candidate: MetaCandidate
  candidateSha: string
  baseCommit: string
} | {
  ok: false
  reason: string
}>> {
  const nowIso = opts.nowIso ?? systemClock.nowIso()
  const cfg = loadConfig()
  if (!cfg.harness_improvement.meta_require_operator_promotion) {
    return { ok: false, reason: "meta_require_operator_promotion is false — refusing auto path" }
  }

  assertRepoRoot(opts.repoRoot)
  let candidate: MetaCandidate
  try {
    candidate = loadMetaCandidate(opts.archiveRoot, opts.candidateId)
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
  if (candidate.status !== "promotion_eligible") {
    return {
      ok: false,
      reason: `status ${candidate.status} is not promotion_eligible`,
    }
  }

  const utility = await recomputeAndSaveUtility({
    archiveRoot: opts.archiveRoot,
    candidateId: opts.candidateId,
    nowIso,
  })
  if (!utility.promotionEligible) {
    return {
      ok: false,
      reason: utility.rejectReason ?? "utility revalidation failed",
    }
  }
  if (utility.validPairs < META_MIN_VALID_PAIRS) {
    return { ok: false, reason: `need ≥${META_MIN_VALID_PAIRS} valid pairs` }
  }
  if (listTrials(opts.archiveRoot, opts.candidateId).length < META_MIN_VALID_PAIRS) {
    return { ok: false, reason: "insufficient trial receipts" }
  }

  const candidateConfig = loadCandidateImproverConfig(
    opts.archiveRoot,
    opts.candidateId,
  )
  if (improverConfigHash(candidateConfig) !== candidate.candidateConfigHash) {
    return { ok: false, reason: "candidate config hash mismatch" }
  }

  const baseCommit = gitRevParse(opts.repoRoot)
  const branch = `harness-meta/${opts.candidateId}`
  const worktreePath = resolve(opts.repoRoot, "..", `trench-bot-meta-${opts.candidateId}`)
  mkdirSync(metaCandidateDir(opts.archiveRoot, opts.candidateId), {
    recursive: true,
    mode: 0o700,
  })

  if (!existsSync(worktreePath)) {
    const add = git(opts.repoRoot, ["worktree", "add", "-b", branch, worktreePath])
    if (add.status !== 0) {
      const add2 = git(opts.repoRoot, ["worktree", "add", worktreePath, branch])
      if (add2.status !== 0) {
        return {
          ok: false,
          reason: `git worktree add failed: ${add.stderr || add2.stderr}`,
        }
      }
    }
  }

  await saveImproverConfig(worktreePath, candidateConfig)

  const confinement = evaluateWorktreeConfinement({
    worktreePath,
    allowlist: [...IMPROVER_CONFIG_ALLOWLIST],
    repoRoot: opts.repoRoot,
  })
  if (!confinement.ok) {
    return {
      ok: false,
      reason: `confinement: ${confinement.violations.join(",")}`,
    }
  }
  const pathCheck = confineDiff(
    confinement.changed.length > 0
      ? confinement.changed
      : [IMPROVER_CONFIG_REL_PATH],
    IMPROVER_CONFIG_ALLOWLIST,
  )
  if (!pathCheck.ok) {
    return {
      ok: false,
      reason: `allowlist: ${pathCheck.violations.join(",")}`,
    }
  }

  let candidateSha: string
  try {
    candidateSha = commitCandidateBranch(
      worktreePath,
      `harness-meta: improver-config (${opts.candidateId})`,
      [IMPROVER_CONFIG_REL_PATH],
    )
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }

  try {
    fastForwardLocalMain({
      repoRoot: opts.repoRoot,
      baseSha: baseCommit,
      branch,
      candidateSha,
      pushOrigin: opts.pushOrigin ?? cfg.harness_improvement.push_origin,
    })
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }

  const promoted = await setMetaCandidateStatus({
    archiveRoot: opts.archiveRoot,
    candidateId: opts.candidateId,
    status: "promoted",
  })
  return { ok: true, candidate: promoted, candidateSha, baseCommit }
}

export function metaStatusSnapshot(archiveRoot: string): Readonly<{
  candidates: ReadonlyArray<Readonly<{
    candidate: MetaCandidate
    trials: number
    utility?: ReturnType<typeof loadUtility>
    operatorNotifiedAt?: string
  }>>
}> {
  const candidates = listMetaCandidateIds(archiveRoot).map((id) => {
    const candidate = loadMetaCandidate(archiveRoot, id)
    const notify = loadMetaOperatorNotifyReceipt(archiveRoot, id)
    return {
      candidate,
      trials: listTrials(archiveRoot, id).length,
      ...(loadUtility(archiveRoot, id)
        ? { utility: loadUtility(archiveRoot, id) }
        : {}),
      ...(notify ? { operatorNotifiedAt: notify.notifiedAt } : {}),
    }
  })
  return { candidates }
}

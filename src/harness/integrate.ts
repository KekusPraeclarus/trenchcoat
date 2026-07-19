import { spawnSync } from "node:child_process"
import { DECISION_POLICY_REL_PATH } from "./paths.js"

export type IntegrateAbortReason =
  | "dirty-worktree"
  | "main-moved"
  | "merge-in-progress"
  | "branch-mismatch"
  | "commit-failed"
  | "ff-failed"
  | "checkout-failed"

export class IntegrateError extends Error {
  readonly reason: IntegrateAbortReason

  constructor(reason: IntegrateAbortReason, detail: string) {
    super(`${reason}: ${detail}`)
    this.name = "IntegrateError"
    this.reason = reason
  }
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

function assertClean(repoRoot: string): void {
  const status = git(repoRoot, ["status", "--porcelain"])
  if (status.status !== 0) {
    throw new IntegrateError("dirty-worktree", status.stderr || "git status failed")
  }
  if (status.stdout.length > 0) {
    throw new IntegrateError("dirty-worktree", "index or worktree not clean")
  }
}

function assertNoMergeInProgress(repoRoot: string): void {
  const mergeHead = git(repoRoot, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])
  if (mergeHead.status === 0 && mergeHead.stdout.length > 0) {
    throw new IntegrateError("merge-in-progress", "MERGE_HEAD present")
  }
  const cherry = git(repoRoot, ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"])
  if (cherry.status === 0 && cherry.stdout.length > 0) {
    throw new IntegrateError("merge-in-progress", "CHERRY_PICK_HEAD present")
  }
  const rebase = git(repoRoot, ["rev-parse", "-q", "--verify", "REBASE_HEAD"])
  if (rebase.status === 0 && rebase.stdout.length > 0) {
    throw new IntegrateError("merge-in-progress", "REBASE_HEAD present")
  }
}

/** Stage and commit only the decision-policy file in the candidate worktree */
export function commitCandidateBranch(
  worktreePath: string,
  title: string,
): string {
  assertNoMergeInProgress(worktreePath)
  const add = git(worktreePath, ["add", "--", DECISION_POLICY_REL_PATH])
  if (add.status !== 0) {
    throw new IntegrateError("commit-failed", add.stderr || "git add failed")
  }
  const commit = git(worktreePath, [
    "commit",
    "-m",
    title.slice(0, 200),
    "--",
    DECISION_POLICY_REL_PATH,
  ])
  if (commit.status !== 0) {
    throw new IntegrateError("commit-failed", commit.stderr || "git commit failed")
  }
  const sha = git(worktreePath, ["rev-parse", "HEAD"])
  if (sha.status !== 0 || sha.stdout.length < 7) {
    throw new IntegrateError("commit-failed", "could not read candidate HEAD")
  }
  return sha.stdout
}

/**
 * Fast-forward local main to the candidate branch. Never pushes.
 * Requires main == baseSha, clean tree, no merge in progress.
 */
export function fastForwardLocalMain(opts: Readonly<{
  repoRoot: string
  baseSha: string
  branch: string
  candidateSha: string
}>): string {
  assertNoMergeInProgress(opts.repoRoot)
  assertClean(opts.repoRoot)

  const mainSha = git(opts.repoRoot, ["rev-parse", "main"])
  if (mainSha.status !== 0) {
    throw new IntegrateError("checkout-failed", mainSha.stderr || "rev-parse main failed")
  }
  if (mainSha.stdout !== opts.baseSha) {
    throw new IntegrateError(
      "main-moved",
      `main=${mainSha.stdout} base=${opts.baseSha}`,
    )
  }

  const branchSha = git(opts.repoRoot, ["rev-parse", opts.branch])
  if (branchSha.status !== 0 || branchSha.stdout !== opts.candidateSha) {
    throw new IntegrateError(
      "branch-mismatch",
      `branch=${branchSha.stdout || "missing"} expected=${opts.candidateSha}`,
    )
  }

  const checkout = git(opts.repoRoot, ["checkout", "main"])
  if (checkout.status !== 0) {
    throw new IntegrateError("checkout-failed", checkout.stderr || "checkout main failed")
  }

  const merge = git(opts.repoRoot, ["merge", "--ff-only", opts.branch])
  if (merge.status !== 0) {
    throw new IntegrateError("ff-failed", merge.stderr || "ff-only merge failed")
  }

  const head = git(opts.repoRoot, ["rev-parse", "HEAD"])
  if (head.status !== 0 || head.stdout !== opts.candidateSha) {
    throw new IntegrateError(
      "ff-failed",
      `HEAD=${head.stdout} expected=${opts.candidateSha}`,
    )
  }
  return head.stdout
}

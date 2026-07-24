import { spawnSync } from "node:child_process"
import { WorkspaceLock } from "../lib/lock.js"
import { repoMutationLockPath } from "../chain-integration/paths.js"
import { DECISION_POLICY_REL_PATH } from "./paths.js"

export type IntegrateAbortReason =
  | "dirty-worktree"
  | "main-moved"
  | "origin-moved"
  | "fetch-failed"
  | "push-failed"
  | "merge-in-progress"
  | "branch-mismatch"
  | "commit-failed"
  | "ff-failed"
  | "checkout-failed"
  | "mutation-lock"

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

function fetchOriginMain(repoRoot: string): string {
  const fetch = git(repoRoot, ["fetch", "origin", "main"])
  if (fetch.status !== 0) {
    throw new IntegrateError("fetch-failed", fetch.stderr || "fetch origin main failed")
  }
  const remote = git(repoRoot, ["rev-parse", "origin/main"])
  if (remote.status !== 0 || remote.stdout.length < 7) {
    throw new IntegrateError("fetch-failed", remote.stderr || "origin/main missing")
  }
  return remote.stdout
}

/** Stage and commit allowlisted path(s) in the candidate worktree */
export function commitCandidateBranch(
  worktreePath: string,
  title: string,
  paths: readonly string[] = [DECISION_POLICY_REL_PATH],
): string {
  assertNoMergeInProgress(worktreePath)
  if (paths.length === 0) {
    throw new IntegrateError("commit-failed", "no paths to commit")
  }
  const add = git(worktreePath, ["add", "--", ...paths])
  if (add.status !== 0) {
    throw new IntegrateError("commit-failed", add.stderr || "git add failed")
  }
  const commit = git(worktreePath, [
    "commit",
    "-m",
    title.slice(0, 200),
    "--",
    ...paths,
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
 * After implementation approval: optionally push candidate → origin/main
 * (ff-only remote update), then fast-forward local main. Push runs first so a
 * failed push leaves local main unchanged. Requires main == baseSha, clean tree,
 * no merge in progress; when pushing, origin/main must also equal baseSha.
 */
export function fastForwardLocalMain(opts: Readonly<{
  repoRoot: string
  baseSha: string
  branch: string
  candidateSha: string
  /** Default true — publish to origin/main after gates (INV-S24) */
  pushOrigin?: boolean
}>): string {
  const pushOrigin = opts.pushOrigin !== false
  const lock = new WorkspaceLock(repoMutationLockPath())
  if (!lock.tryAcquire()) {
    throw new IntegrateError("mutation-lock", "repo mutation lock held")
  }
  try {
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

    if (pushOrigin) {
      const remote = fetchOriginMain(opts.repoRoot)
      if (remote !== opts.baseSha) {
        throw new IntegrateError(
          "origin-moved",
          `origin/main=${remote} base=${opts.baseSha}`,
        )
      }
      const push = git(opts.repoRoot, [
        "push",
        "origin",
        `${opts.candidateSha}:refs/heads/main`,
      ])
      if (push.status !== 0) {
        throw new IntegrateError("push-failed", push.stderr || push.stdout || "push failed")
      }
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
  } finally {
    lock.release()
  }
}

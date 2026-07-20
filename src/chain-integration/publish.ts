import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { WorkspaceLock } from "../lib/lock.js"
import { repoMutationLockPath } from "./paths.js"
import { deployRuntimeFromRepo, rollbackRuntimePrev } from "../harness/deploy.js"
import { systemClock } from "../lib/clock.js"

function git(
  cwd: string,
  args: readonly string[],
): { status: number; stdout: string; stderr: string } {
  const out = spawnSync("git", [...args], { cwd, encoding: "utf8" })
  return {
    status: out.status ?? 1,
    stdout: (out.stdout ?? "").trim(),
    stderr: (out.stderr ?? "").trim(),
  }
}

export class PublishError extends Error {
  readonly code: string
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`)
    this.name = "PublishError"
    this.code = code
  }
}

export function assertCleanMain(repoRoot: string): string {
  const branch = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])
  if (branch.status !== 0 || branch.stdout !== "main") {
    throw new PublishError("wrong-branch", branch.stdout || "not on main")
  }
  const status = git(repoRoot, ["status", "--porcelain"])
  if (status.status !== 0 || status.stdout.length > 0) {
    throw new PublishError("dirty-worktree", status.stdout || "dirty")
  }
  for (const head of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REBASE_HEAD"]) {
    const check = git(repoRoot, ["rev-parse", "-q", "--verify", head])
    if (check.status === 0 && check.stdout) {
      throw new PublishError("merge-in-progress", head)
    }
  }
  const sha = git(repoRoot, ["rev-parse", "HEAD"])
  if (sha.status !== 0 || sha.stdout.length < 7) {
    throw new PublishError("rev-parse", "HEAD missing")
  }
  return sha.stdout
}

export function fetchOriginMain(repoRoot: string): string {
  const fetch = git(repoRoot, ["fetch", "origin", "main"])
  if (fetch.status !== 0) {
    throw new PublishError("fetch-failed", fetch.stderr || "fetch failed")
  }
  const remote = git(repoRoot, ["rev-parse", "origin/main"])
  if (remote.status !== 0) {
    throw new PublishError("origin-main-missing", remote.stderr)
  }
  return remote.stdout
}

export function prepareWorktree(args: Readonly<{
  repoRoot: string
  integrationId: string
  baseSha: string
}>): { worktreePath: string; branch: string } {
  const branch = `chain-integration/${args.integrationId}`
  const worktreePath = join(args.repoRoot, "..", `trench-bot-${args.integrationId}`)
  if (!existsSync(worktreePath)) {
    const add = git(args.repoRoot, [
      "worktree",
      "add",
      "-b",
      branch,
      worktreePath,
      args.baseSha,
    ])
    if (add.status !== 0) {
      throw new PublishError("worktree-add", add.stderr || add.stdout)
    }
  }
  return { worktreePath, branch }
}

export function commitIntegration(args: Readonly<{
  worktreePath: string
  slug: string
  display: string
}>): string {
  const paths = [
    `chains/${args.slug}.json`,
    "src/lib/chains.generated.ts",
    `tests/unit/chains/${args.slug}.test.ts`,
    "docs/architecture/chains.md",
    "docs/architecture/security-gate.md",
  ]
  const existing = paths.filter((p) => existsSync(join(args.worktreePath, p)))
  const add = git(args.worktreePath, ["add", "--", ...existing])
  if (add.status !== 0) {
    throw new PublishError("commit-failed", add.stderr || "git add failed")
  }
  const msg = `Add ${args.display} chain to the registry.`
  const commit = git(args.worktreePath, ["commit", "-m", msg])
  if (commit.status !== 0) {
    throw new PublishError("commit-failed", commit.stderr || "git commit failed")
  }
  const sha = git(args.worktreePath, ["rev-parse", "HEAD"])
  if (sha.status !== 0) throw new PublishError("commit-failed", "no HEAD")
  return sha.stdout
}

export function pushAndFastForward(args: Readonly<{
  repoRoot: string
  worktreePath: string
  branch: string
  baseSha: string
  candidateSha: string
}>): void {
  const lock = new WorkspaceLock(repoMutationLockPath())
  if (!lock.tryAcquire()) {
    throw new PublishError("mutation-lock", "repo mutation lock held")
  }
  try {
    const localMain = assertCleanMain(args.repoRoot)
    if (localMain !== args.baseSha) {
      throw new PublishError("main-moved", `main=${localMain} base=${args.baseSha}`)
    }
    const remote = fetchOriginMain(args.repoRoot)
    if (remote !== args.baseSha) {
      throw new PublishError("origin-moved", `origin/main=${remote} base=${args.baseSha}`)
    }

    const push = git(args.worktreePath, [
      "push",
      "origin",
      `${args.candidateSha}:refs/heads/main`,
    ])
    if (push.status !== 0) {
      throw new PublishError("push-failed", push.stderr || push.stdout)
    }

    const ff = git(args.repoRoot, ["merge", "--ff-only", args.candidateSha])
    if (ff.status !== 0) {
      throw new PublishError("ff-failed", ff.stderr || ff.stdout)
    }
    const head = git(args.repoRoot, ["rev-parse", "HEAD"])
    if (head.stdout !== args.candidateSha) {
      throw new PublishError("ff-failed", `HEAD=${head.stdout}`)
    }
  } finally {
    lock.release()
  }
}

export async function deployIntegration(args: Readonly<{
  repoRoot: string
  archiveRoot: string
  sourceCommit: string
  integrationId: string
}>): Promise<{ ok: boolean; detail?: string; rolledBack: boolean }> {
  const result = await deployRuntimeFromRepo({
    repoRoot: args.repoRoot,
    archiveRoot: args.archiveRoot,
    sourceCommit: args.sourceCommit,
    hypothesisId: args.integrationId,
    nowIso: systemClock.nowIso(),
  })
  if (result.ok) return { ok: true, rolledBack: false }
  return {
    ok: false,
    detail: (result.stderr || result.stdout).slice(0, 500),
    rolledBack: result.rolledBack,
  }
}

export function revertAndRedeploy(args: Readonly<{
  repoRoot: string
  candidateSha: string
  baseSha: string
}>): { ok: boolean; detail?: string } {
  const lock = new WorkspaceLock(repoMutationLockPath())
  if (!lock.tryAcquire()) {
    return { ok: false, detail: "mutation lock held during revert" }
  }
  try {
    assertCleanMain(args.repoRoot)
    const revert = git(args.repoRoot, [
      "revert",
      "--no-edit",
      args.candidateSha,
    ])
    if (revert.status !== 0) {
      return { ok: false, detail: revert.stderr || "revert failed" }
    }
    const sha = git(args.repoRoot, ["rev-parse", "HEAD"])
    const push = git(args.repoRoot, ["push", "origin", "HEAD:main"])
    if (push.status !== 0) {
      return { ok: false, detail: push.stderr || "revert push failed" }
    }
    rollbackRuntimePrev()
    const script = join(args.repoRoot, "ops", "install-launchd.sh")
    const deploy = spawnSync(script, [], {
      cwd: args.repoRoot,
      encoding: "utf8",
      timeout: 10 * 60_000,
    })
    if ((deploy.status ?? 1) !== 0) {
      return {
        ok: false,
        detail: `revert deployed locally but install failed: ${(deploy.stderr || "").slice(0, 300)}`,
      }
    }
    void sha
    return { ok: true }
  } finally {
    lock.release()
  }
}

export function readDeploymentSourceCommit(
  runtimeRoot = join(homedir(), ".trenchcoat", "runtime"),
): string | undefined {
  const path = join(runtimeRoot, "deployment.json")
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { sourceCommit?: string }
    return raw.sourceCommit
  } catch {
    return undefined
  }
}

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { loadHypothesis, saveHypothesis, hypothesisDir } from "./propose.js"
import type { HarnessHypothesis } from "../contracts/schemas.js"
import {
  allowlistForLane,
  type HarnessLane,
} from "./paths.js"

export type PrepareResult = Readonly<{
  hypothesis: HarnessHypothesis
  worktreePath: string
  branch: string
  confinement: {
    ok: boolean
    violations: readonly string[]
  }
  lane: HarnessLane
}>

function listFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".git" || name === "node_modules" || name === "dist") continue
      const path = join(dir, name)
      const st = statSync(path)
      if (st.isDirectory()) walk(path)
      else out.push(relative(root, path))
    }
  }
  walk(root)
  return out
}

function matchAllowlist(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3)
      return path === prefix || path.startsWith(`${prefix}/`)
    }
    if (pattern.includes("*")) {
      const re = new RegExp(`^${pattern.replace(/\./gu, "\\.").replace(/\*\*/gu, ".*").replace(/\*/gu, "[^/]*")}$`, "u")
      return re.test(path)
    }
    return path === pattern
  })
}

export function confineDiff(
  changedPaths: readonly string[],
  allowlist: readonly string[],
): { ok: boolean, violations: string[] } {
  const forbiddenPrefixes = [
    "src/orchestrator/audit",
    "src/orchestrator/scorecard",
    "src/router/",
    "src/chat/",
    "src/harness/",
    "src/contracts/",
    ".env",
    "ops/launchd/",
  ]
  const violations: string[] = []
  for (const raw of changedPaths) {
    const path = raw.split("/").reduce<string[]>((acc, part) => {
      if (part === "" || part === ".") return acc
      if (part === "..") {
        acc.pop()
        return acc
      }
      acc.push(part)
      return acc
    }, []).join("/")
    if (forbiddenPrefixes.some((p) => path === p || path.startsWith(p))) {
      violations.push(`forbidden:${path}`)
      continue
    }
    if (!matchAllowlist(path, allowlist)) {
      violations.push(`outside-allowlist:${path}`)
    }
  }
  return { ok: violations.length === 0, violations }
}

export async function prepareWorktree(opts: Readonly<{
  archiveRoot: string
  hypothesisId: string
  repoRoot: string
  nowIso: string
  lane?: HarnessLane
}>): Promise<PrepareResult> {
  const lane = opts.lane ?? "policy"
  const hypothesis = loadHypothesis(opts.archiveRoot, opts.hypothesisId)
  if (
    hypothesis.status !== "plan_approved"
    && hypothesis.status !== "proposed"
    && hypothesis.status !== "prepared"
  ) {
    throw new Error(`Hypothesis ${opts.hypothesisId} status ${hypothesis.status} cannot prepare`)
  }

  const branch = lane === "meta"
    ? `harness-meta/${opts.hypothesisId}`
    : `harness/${opts.hypothesisId}`
  const worktreePath = resolve(opts.repoRoot, "..", `trench-bot-${opts.hypothesisId}`)
  mkdirSync(hypothesisDir(opts.archiveRoot, opts.hypothesisId), { recursive: true, mode: 0o700 })

  if (!existsSync(worktreePath)) {
    const add = spawnSync(
      "git",
      ["worktree", "add", "-b", branch, worktreePath],
      { cwd: opts.repoRoot, encoding: "utf8" },
    )
    if (add.status !== 0) {
      const add2 = spawnSync(
        "git",
        ["worktree", "add", worktreePath, branch],
        { cwd: opts.repoRoot, encoding: "utf8" },
      )
      if (add2.status !== 0) {
        throw new Error(`git worktree add failed: ${add.stderr || add2.stderr}`)
      }
    }
  }

  const files = listFiles(worktreePath)
  await writeAtomicFile(
    join(hypothesisDir(opts.archiveRoot, opts.hypothesisId), "worktree.json"),
    `${JSON.stringify({
      worktreePath,
      branch,
      lane,
      preparedAt: opts.nowIso,
      baselineFileCount: files.length,
    }, null, 2)}\n`,
  )

  const allowlist = allowlistForLane(lane)
  await writeAtomicFile(
    join(worktreePath, "HARNESS_BRIEF.md"),
    [
      `# Harness patch brief`,
      "",
      `Hypothesis: ${hypothesis.hypothesisId}`,
      `Lane: ${lane}`,
      `Primary metric: ${hypothesis.primaryMetric}`,
      `Allowlist:`,
      ...allowlist.map((p) => `- ${p}`),
      "",
      hypothesis.rationale,
      "",
      "Do not edit host audit, router, chat, harness, contracts, or secrets.",
      lane === "meta"
        ? "Improver-config changes only."
        : "Decision-policy changes only.",
      "",
    ].join("\n"),
  )

  const updated = {
    ...hypothesis,
    status: "prepared" as const,
    allowlistPaths: [...allowlist],
  }
  await saveHypothesis(opts.archiveRoot, updated)

  return {
    hypothesis: updated,
    worktreePath,
    branch,
    confinement: { ok: true, violations: [] },
    lane,
  }
}

export function evaluateWorktreeConfinement(opts: Readonly<{
  worktreePath: string
  allowlist: readonly string[]
  repoRoot: string
}>): { ok: boolean, violations: string[], changed: string[] } {
  const diff = spawnSync(
    "git",
    ["diff", "--name-only", "HEAD"],
    { cwd: opts.worktreePath, encoding: "utf8" },
  )
  const staged = spawnSync(
    "git",
    ["diff", "--name-only", "--cached"],
    { cwd: opts.worktreePath, encoding: "utf8" },
  )
  const untracked = spawnSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd: opts.worktreePath, encoding: "utf8" },
  )
  const changed = [
    ...new Set([
      ...(diff.stdout ?? "").split("\n"),
      ...(staged.stdout ?? "").split("\n"),
      ...(untracked.stdout ?? "").split("\n"),
    ].map((s) => s.trim()).filter(Boolean)),
  ]
  const filtered = changed.filter((p) => p !== "HARNESS_BRIEF.md")
  const confinement = confineDiff(filtered, opts.allowlist)
  return { ...confinement, changed: filtered }
}

export function readWorktreeMeta(
  archiveRoot: string,
  hypothesisId: string,
): { worktreePath: string, branch: string, lane?: HarnessLane } {
  const path = join(hypothesisDir(archiveRoot, hypothesisId), "worktree.json")
  if (!existsSync(path)) throw new Error("Worktree not prepared")
  return JSON.parse(readFileSync(path, "utf8")) as {
    worktreePath: string
    branch: string
    lane?: HarnessLane
  }
}

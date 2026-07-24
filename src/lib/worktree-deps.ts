import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

/** Marker that typecheck/lint scripts can resolve (tsc via node_modules/.bin). */
export function worktreeDepsMarker(worktreePath: string): string {
  return join(worktreePath, "node_modules", ".bin", "tsc")
}

export type WorktreeDepsResult = Readonly<{
  ok: boolean
  detail: string
  skipped: boolean
}>

export type WorktreeInstallRunner = (
  cwd: string,
  cmd: string,
  args: readonly string[],
  timeoutMs: number,
) => { ok: boolean; detail: string }

function defaultInstallRunner(
  cwd: string,
  cmd: string,
  args: readonly string[],
  timeoutMs: number,
): { ok: boolean; detail: string } {
  const out = spawnSync(cmd, [...args], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    env: process.env,
  })
  const detail = ((out.stderr || out.stdout) ?? "").slice(0, 1_000)
  return { ok: out.status === 0, detail }
}

/**
 * Sibling git worktrees do not inherit the main checkout's node_modules.
 * Gates (and harness test runs) must install before invoking pnpm scripts.
 */
export function ensureWorktreeDeps(args: Readonly<{
  worktreePath: string
  timeoutMs?: number
  runInstall?: WorktreeInstallRunner
}>): WorktreeDepsResult {
  if (existsSync(worktreeDepsMarker(args.worktreePath))) {
    return { ok: true, detail: "deps-present", skipped: true }
  }
  const run = args.runInstall ?? defaultInstallRunner
  const result = run(
    args.worktreePath,
    "pnpm",
    ["install", "--frozen-lockfile"],
    args.timeoutMs ?? 600_000,
  )
  if (!result.ok) {
    return {
      ok: false,
      detail: result.detail || "pnpm install --frozen-lockfile failed",
      skipped: false,
    }
  }
  if (!existsSync(worktreeDepsMarker(args.worktreePath))) {
    return {
      ok: false,
      detail: "pnpm install finished but node_modules/.bin/tsc missing",
      skipped: false,
    }
  }
  return { ok: true, detail: "installed", skipped: false }
}

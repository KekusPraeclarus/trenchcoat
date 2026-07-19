import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { systemClock } from "../lib/clock.js"
import { hypothesisDir } from "./propose.js"

export type DeployResult = Readonly<{
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  rolledBack: boolean
}>

export type DeploymentReceipt = Readonly<{
  schema: 1
  hypothesisId?: string
  sourceCommit: string
  ok: boolean
  exitCode: number
  deployedAt: string
  rolledBack: boolean
  detail?: string
}>

function defaultRuntimeRoot(): string {
  return join(homedir(), ".trenchcoat", "runtime")
}

function defaultRuntimePrev(): string {
  return join(homedir(), ".trenchcoat", "runtime.prev")
}

/** Restore ~/.trenchcoat/runtime from runtime.prev when present */
export function rollbackRuntimePrev(opts?: Readonly<{
  runtimeRoot?: string
  runtimePrev?: string
}>): boolean {
  const runtimeRoot = opts?.runtimeRoot ?? defaultRuntimeRoot()
  const runtimePrev = opts?.runtimePrev ?? defaultRuntimePrev()
  if (!existsSync(runtimePrev)) return false
  if (existsSync(runtimeRoot)) {
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
  renameSync(runtimePrev, runtimeRoot)
  return true
}

export async function writeDeploymentReceipt(
  archiveRoot: string,
  receipt: DeploymentReceipt,
  hypothesisId?: string,
): Promise<void> {
  const dir = hypothesisId
    ? hypothesisDir(archiveRoot, hypothesisId)
    : join(archiveRoot, "..", "harness-improvements", "_deploy")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  await writeAtomicFile(
    join(dir, "deployment-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    0o600,
  )
}

/**
 * Deploy host runtime from a clean local repo via ops/install-launchd.sh.
 * Never passes --allow-dirty. On failure, attempts runtime.prev rollback.
 */
export async function deployRuntimeFromRepo(opts: Readonly<{
  repoRoot: string
  archiveRoot: string
  sourceCommit: string
  hypothesisId?: string
  nowIso?: string
  withHarness?: boolean
}>): Promise<DeployResult> {
  const script = join(opts.repoRoot, "ops", "install-launchd.sh")
  if (!existsSync(script)) {
    const result: DeployResult = {
      ok: false,
      exitCode: 127,
      stdout: "",
      stderr: "install-launchd.sh missing",
      rolledBack: false,
    }
    await writeDeploymentReceipt(opts.archiveRoot, {
      schema: 1,
      ...(opts.hypothesisId ? { hypothesisId: opts.hypothesisId } : {}),
      sourceCommit: opts.sourceCommit,
      ok: false,
      exitCode: 127,
      deployedAt: opts.nowIso ?? systemClock.nowIso(),
      rolledBack: false,
      detail: result.stderr,
    }, opts.hypothesisId)
    return result
  }

  const args = opts.withHarness === false ? ["--without-harness"] : []
  const spawned = spawnSync(script, args, {
    cwd: opts.repoRoot,
    encoding: "utf8",
    timeout: 10 * 60_000,
  })
  const exitCode = spawned.status ?? 1
  const ok = exitCode === 0
  let rolledBack = false
  if (!ok) {
    rolledBack = rollbackRuntimePrev()
  }

  const result: DeployResult = {
    ok,
    exitCode,
    stdout: spawned.stdout ?? "",
    stderr: spawned.stderr ?? "",
    rolledBack,
  }
  await writeDeploymentReceipt(opts.archiveRoot, {
    schema: 1,
    ...(opts.hypothesisId ? { hypothesisId: opts.hypothesisId } : {}),
    sourceCommit: opts.sourceCommit,
    ok,
    exitCode,
    deployedAt: opts.nowIso ?? systemClock.nowIso(),
    rolledBack,
    ...(ok ? {} : { detail: (result.stderr || result.stdout).slice(0, 500) }),
  }, opts.hypothesisId)
  return result
}

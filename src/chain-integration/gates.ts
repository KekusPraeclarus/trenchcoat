import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFileFsync, sha256Bytes } from "../lib/fs-atomic.js"
import { probeCursorCli } from "../orchestrator/session.js"

export type GateResult = Readonly<{
  ok: boolean
  steps: ReadonlyArray<{ name: string; ok: boolean; detail?: string }>
  hash: `sha256:${string}`
}>

function run(
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

export async function runCleanGate(args: Readonly<{
  worktreePath: string
  artifactDir: string
  skipFullTests?: boolean
}>): Promise<GateResult> {
  const steps: Array<{ name: string; ok: boolean; detail?: string }> = []

  const probe = await probeCursorCli()
  steps.push({
    name: "cursor-cli",
    ok: probe.ok,
    detail: probe.detail,
  })

  const generate = run(
    args.worktreePath,
    "pnpm",
    ["exec", "tsx", "scripts/generate-chains.ts", "--check"],
    60_000,
  )
  steps.push({ name: "generate-chains-check", ...generate })

  const diffCheck = run(args.worktreePath, "git", ["diff", "--check"], 30_000)
  steps.push({ name: "git-diff-check", ...diffCheck })

  // Secret scan over changed files
  const changed = spawnSync(
    "git",
    ["diff", "--name-only", "HEAD"],
    { cwd: args.worktreePath, encoding: "utf8" },
  )
  const untracked = spawnSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd: args.worktreePath, encoding: "utf8" },
  )
  const files = [
    ...(changed.stdout ?? "").split("\n"),
    ...(untracked.stdout ?? "").split("\n"),
  ].map((s) => s.trim()).filter(Boolean)
  let secretOk = true
  let secretDetail = ""
  const secretRe = /(PRIVATE_KEY|SECRET_KEY|API_KEY|BOT_TOKEN)\s*=\s*['"][^'"]+['"]/u
  for (const rel of files) {
    const abs = join(args.worktreePath, rel)
    if (!existsSync(abs)) continue
    try {
      const text = readFileSync(abs, "utf8")
      if (secretRe.test(text)) {
        secretOk = false
        secretDetail = `secret-like assignment in ${rel}`
        break
      }
    } catch {
      // ignore unreadable
    }
  }
  steps.push({
    name: "secret-scan",
    ok: secretOk,
    ...(secretDetail ? { detail: secretDetail } : {}),
  })

  if (!args.skipFullTests) {
    const typecheck = run(args.worktreePath, "pnpm", ["typecheck"], 180_000)
    steps.push({ name: "typecheck", ...typecheck })
    const lint = run(args.worktreePath, "pnpm", ["lint"], 120_000)
    steps.push({ name: "lint", ...lint })
    const unit = run(args.worktreePath, "pnpm", ["test:unit"], 300_000)
    steps.push({ name: "test:unit", ...unit })
    const build = run(args.worktreePath, "pnpm", ["build"], 180_000)
    steps.push({ name: "build", ...build })
  }

  const ok = steps.every((s) => s.ok)
  const payload = `${JSON.stringify({ ok, steps }, null, 2)}\n`
  await writeAtomicFileFsync(join(args.artifactDir, "gate.json"), payload, 0o600)
  return {
    ok,
    steps,
    hash: sha256Bytes(Buffer.from(payload)),
  }
}

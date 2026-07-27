import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFileFsync, sha256Bytes } from "../lib/fs-atomic.js"
import { ensureWorktreeDeps } from "../lib/worktree-deps.js"
import { probeCursorCli } from "../orchestrator/session.js"
import type { GateResult } from "./schemas.js"

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
  // Prefer the end of the stream so vitest failure summaries survive truncation
  const combined = `${out.stdout ?? ""}\n${out.stderr ?? ""}`.trim()
  const tail = combined.slice(-1_000)
  const detail = out.status === null
    ? `timeout-or-signal: ${tail || out.error?.message || "no output"}`
    : tail
  return { ok: out.status === 0, detail }
}

export async function runRemediationGates(args: Readonly<{
  worktreePath: string
  artifactDir: string
  skipFullTests?: boolean
}>): Promise<GateResult & { hash: `sha256:${string}` }> {
  const steps: Array<{ name: string; ok: boolean; detail?: string }> = []

  const probe = await probeCursorCli()
  steps.push({
    name: "cursor-cli",
    ok: probe.ok,
    detail: probe.detail,
  })

  const diffCheck = run(args.worktreePath, "git", ["diff", "--check"], 30_000)
  steps.push({ name: "git-diff-check", ...diffCheck })

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
      // ignore
    }
  }
  steps.push({
    name: "secret-scan",
    ok: secretOk,
    ...(secretDetail ? { detail: secretDetail } : {}),
  })

  if (!args.skipFullTests) {
    const deps = ensureWorktreeDeps({ worktreePath: args.worktreePath })
    steps.push({
      name: "pnpm-install",
      ok: deps.ok,
      detail: deps.detail,
    })
    if (deps.ok) {
      const typecheck = run(args.worktreePath, "pnpm", ["typecheck"], 180_000)
      steps.push({ name: "typecheck", ...typecheck })
      const lint = run(args.worktreePath, "pnpm", ["lint"], 120_000)
      steps.push({ name: "lint", ...lint })
      const all = run(args.worktreePath, "pnpm", ["test:all"], 900_000)
      steps.push({ name: "test:all", ...all })
    }
  }

  const ok = steps.every((s) => s.ok)
  const payload = `${JSON.stringify({ schema: 1, ok, steps }, null, 2)}\n`
  await writeAtomicFileFsync(join(args.artifactDir, "gate.json"), payload, 0o600)
  return {
    schema: 1,
    ok,
    steps,
    hash: sha256Bytes(Buffer.from(payload)),
  }
}

export const PREDEFINED_SMOKE: Readonly<Record<string, readonly string[]>> = {
  "x-scan": ["tc", "status", "--json"],
  health: ["tc", "status", "--json"],
  orchestrator: ["tc", "status", "--json"],
  fomo: ["tc", "status", "--json"],
  default: ["tc", "status", "--json"],
}

export function selectSmokeChecks(
  component: string | undefined,
  proposed: readonly string[] | undefined,
): string[] {
  if (proposed && proposed.length > 0) {
    return proposed.filter((c) =>
      c === "tc-status"
      || c === "status"
      || c.startsWith("smoke:"),
    ).slice(0, 8)
  }
  const key = component && PREDEFINED_SMOKE[component] ? component : "default"
  return [`smoke:${key}`]
}

export function runSmokeChecks(args: Readonly<{
  repoRoot: string
  checks: readonly string[]
}>): { ok: boolean; detail?: string } {
  for (const check of args.checks) {
    if (check === "tc-status" || check === "status" || check.startsWith("smoke:")) {
      const out = spawnSync("pnpm", ["exec", "tsx", "src/cli.ts", "status", "--json"], {
        cwd: args.repoRoot,
        encoding: "utf8",
        timeout: 60_000,
      })
      if ((out.status ?? 1) !== 0) {
        return { ok: false, detail: (out.stderr || out.stdout || "status failed").slice(0, 300) }
      }
      continue
    }
    return { ok: false, detail: `unknown-smoke:${check}` }
  }
  return { ok: true }
}

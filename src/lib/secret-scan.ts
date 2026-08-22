import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** Same assignment shape as the mutation-lane regex fallback. */
export const SECRET_ASSIGNMENT_RE =
  /(?:PRIVATE_KEY|SECRET_KEY|API_KEY|BOT_TOKEN|HMAC_KEY|WEBHOOK_URL|APP_SECRET|APP_MNEMONIC|API_HASH)\s*=\s*(?:['"][^'"]{8,}['"]|[^\s'"#]{8,})/u

export type SecretScanRunner = (
  cwd: string,
  cmd: string,
  args: readonly string[],
  timeoutMs: number,
) => { ok: boolean; detail: string }

export type SecretScanResult = Readonly<{
  ok: boolean
  detail?: string
  engine: "gitleaks" | "regex-fallback"
}>

function defaultRunner(
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
  const combined = `${out.stdout ?? ""}\n${out.stderr ?? ""}`.trim()
  const tail = combined.slice(-1_000)
  if (out.error && (out.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { ok: false, detail: "not-found" }
  }
  const detail = out.status === null
    ? `timeout-or-signal: ${tail || out.error?.message || "no output"}`
    : tail
  return { ok: out.status === 0, detail }
}

export function listDirtyWorktreeFiles(worktreePath: string): string[] {
  const changed = spawnSync("git", ["diff", "--name-only", "HEAD"], {
    cwd: worktreePath,
    encoding: "utf8",
  })
  const untracked = spawnSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd: worktreePath, encoding: "utf8" },
  )
  return [
    ...(changed.stdout ?? "").split("\n"),
    ...(untracked.stdout ?? "").split("\n"),
  ].map((s) => s.trim()).filter(Boolean)
}

function gitleaksPresent(
  worktreePath: string,
  run: SecretScanRunner,
): boolean {
  const probe = run(worktreePath, "gitleaks", ["version"], 10_000)
  return probe.ok
}

function scanWithRegex(
  worktreePath: string,
  files: readonly string[],
): SecretScanResult {
  for (const rel of files) {
    const abs = join(worktreePath, rel)
    if (!existsSync(abs)) continue
    try {
      const text = readFileSync(abs, "utf8")
      if (SECRET_ASSIGNMENT_RE.test(text)) {
        return {
          ok: false,
          detail: `secret-like assignment in ${rel}`,
          engine: "regex-fallback",
        }
      }
    } catch {
      // skip unreadable files
    }
  }
  return { ok: true, engine: "regex-fallback" }
}

/**
 * Prefer gitleaks dir on the worktree. Use the assignment regex when
 * the binary is missing so mutation lanes still run on hosts without it.
 */
export function scanWorktreeSecrets(args: Readonly<{
  worktreePath: string
  files: readonly string[]
  run?: SecretScanRunner
  hasGitleaks?: boolean
  timeoutMs?: number
}>): SecretScanResult {
  const run = args.run ?? defaultRunner
  const useGitleaks = args.hasGitleaks ?? gitleaksPresent(args.worktreePath, run)
  if (!useGitleaks) {
    return scanWithRegex(args.worktreePath, args.files)
  }

  const configPath = join(args.worktreePath, ".gitleaks.toml")
  const gitleaksArgs = [
    "dir",
    "--no-banner",
    "--redact",
    ...(existsSync(configPath) ? ["--config", configPath] : []),
    args.worktreePath,
  ]
  const result = run(
    args.worktreePath,
    "gitleaks",
    gitleaksArgs,
    args.timeoutMs ?? 60_000,
  )
  if (result.detail === "not-found") {
    return scanWithRegex(args.worktreePath, args.files)
  }
  return {
    ok: result.ok,
    engine: "gitleaks",
    ...(result.detail ? { detail: result.detail } : {}),
  }
}

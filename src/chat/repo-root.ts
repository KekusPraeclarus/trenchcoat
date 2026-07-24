import { existsSync, realpathSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { assertRepoRoot } from "../harness/pr.js"

/**
 * Resolve the git checkout for Telegram /plan and /agent turns.
 * Path comes only from host env (never Telegram text). Fail closed.
 */
export function resolveChatRepoRoot(args?: Readonly<{
  env?: NodeJS.ProcessEnv
}>): string {
  const env = args?.env ?? process.env
  const fromEnv = env["TRENCHCOAT_REPO_ROOT"]?.trim()
  if (!fromEnv) {
    throw new Error(
      "TRENCHCOAT_REPO_ROOT unset — cannot run /plan or /agent until install writes the checkout path",
    )
  }
  if (!isAbsolute(fromEnv)) {
    throw new Error(`TRENCHCOAT_REPO_ROOT must be absolute: ${fromEnv}`)
  }
  if (!existsSync(fromEnv)) {
    throw new Error(`TRENCHCOAT_REPO_ROOT does not exist: ${fromEnv}`)
  }
  let resolved: string
  try {
    resolved = realpathSync(fromEnv)
  } catch {
    throw new Error(`TRENCHCOAT_REPO_ROOT is not readable: ${fromEnv}`)
  }
  if (!isAbsolute(resolved)) {
    throw new Error(`TRENCHCOAT_REPO_ROOT resolved non-absolute: ${resolved}`)
  }
  assertRepoRoot(resolved)
  // Prefer an install-marked checkout when present (ops/, docs/)
  if (!existsSync(join(resolved, "ops")) || !existsSync(join(resolved, "docs"))) {
    throw new Error(`Not a trenchcoat repo root (missing ops/ or docs/): ${resolved}`)
  }
  return resolved
}

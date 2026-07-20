import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { ChainManifestSchema, type ChainManifest } from "../lib/chain-manifest.js"

const FORBIDDEN_PREFIXES = [
  "src/chain-integration/",
  "src/harness/",
  "src/orchestrator/",
  "src/router/",
  "src/chat/",
  "src/prompts/",
  "ops/",
  ".env",
  "config/",
  "agent/",
]

function listChanged(worktreePath: string): string[] {
  const diff = spawnSync("git", ["diff", "--name-only", "HEAD"], {
    cwd: worktreePath,
    encoding: "utf8",
  })
  const staged = spawnSync("git", ["diff", "--name-only", "--cached"], {
    cwd: worktreePath,
    encoding: "utf8",
  })
  const untracked = spawnSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd: worktreePath, encoding: "utf8" },
  )
  return [...new Set([
    ...(diff.stdout ?? "").split("\n"),
    ...(staged.stdout ?? "").split("\n"),
    ...(untracked.stdout ?? "").split("\n"),
  ].map((s) => s.trim()).filter(Boolean))]
}

function isRegularFile(abs: string): boolean {
  if (!existsSync(abs)) return false
  const st = lstatSync(abs)
  return st.isFile() && !st.isSymbolicLink()
}

export function evaluateBuildConfinement(args: Readonly<{
  worktreePath: string
  slug: string
  baselineManifestSlugs: readonly string[]
  validatedManifest: ChainManifest
}>): { ok: boolean; violations: string[]; changed: string[] } {
  const changed = listChanged(args.worktreePath)
  const violations: string[] = []
  const allowed = new Set([
    `chains/${args.slug}.json`,
    "src/lib/chains.generated.ts",
    `tests/unit/chains/${args.slug}.test.ts`,
  ])

  for (const path of changed) {
    if (FORBIDDEN_PREFIXES.some((p) => path === p || path.startsWith(p))) {
      violations.push(`forbidden:${path}`)
      continue
    }
    if (!allowed.has(path) && !path.startsWith("docs/architecture/")) {
      // docs allowed only in finalize; build must not touch docs
      if (path.startsWith("docs/")) {
        violations.push(`docs-too-early:${path}`)
        continue
      }
      violations.push(`outside-allowlist:${path}`)
    }
  }

  // Existing manifests must be byte-identical
  for (const slug of args.baselineManifestSlugs) {
    if (slug === args.slug) continue
    const abs = join(args.worktreePath, "chains", `${slug}.json`)
    if (!existsSync(abs)) {
      violations.push(`missing-baseline-manifest:${slug}`)
      continue
    }
  }

  const newManifestPath = join(args.worktreePath, "chains", `${args.slug}.json`)
  if (!isRegularFile(newManifestPath)) {
    violations.push("new-manifest-missing-or-symlink")
  } else {
    try {
      const written = ChainManifestSchema.parse(
        JSON.parse(readFileSync(newManifestPath, "utf8")),
      )
      if (JSON.stringify(written) !== JSON.stringify(args.validatedManifest)) {
        violations.push("manifest-differs-from-validated")
      }
    } catch {
      violations.push("manifest-parse-failed")
    }
  }

  const generated = join(args.worktreePath, "src/lib/chains.generated.ts")
  if (!isRegularFile(generated)) {
    violations.push("generated-missing")
  }

  return { ok: violations.length === 0, violations, changed }
}

export function evaluateFinalizeConfinement(args: Readonly<{
  worktreePath: string
  slug: string
  afterBuildChanged: readonly string[]
}>): { ok: boolean; violations: string[]; changed: string[] } {
  const changed = listChanged(args.worktreePath)
  const violations: string[] = []
  const buildSet = new Set(args.afterBuildChanged)
  const allowedNew = new Set([
    "docs/architecture/chains.md",
    "docs/architecture/security-gate.md",
    `tests/unit/chains/${args.slug}.test.ts`,
  ])

  for (const path of changed) {
    if (buildSet.has(path)) continue
    if (FORBIDDEN_PREFIXES.some((p) => path === p || path.startsWith(p))) {
      violations.push(`forbidden:${path}`)
      continue
    }
    if (!allowedNew.has(path)) {
      violations.push(`outside-finalize-allowlist:${path}`)
    }
    const abs = join(args.worktreePath, path)
    if (!isRegularFile(abs) && existsSync(abs)) {
      violations.push(`symlink-or-special:${path}`)
    }
  }

  return { ok: violations.length === 0, violations, changed }
}

export function listRepoChainSlugs(repoRoot: string): string[] {
  const dir = join(repoRoot, "chains")
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/u, ""))
    .sort()
}

export function relativeFrom(root: string, abs: string): string {
  return relative(root, abs)
}

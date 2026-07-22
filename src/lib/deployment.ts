import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { writeAtomicFile } from "./fs-atomic.js"

/** Manifest schema for ~/.trenchcoat/runtime/deployment.json */
export const DEPLOYMENT_MANIFEST_SCHEMA = 2 as const

/** Must match live config schema in src/lib/config.ts / migrations */
export const DEPLOYMENT_CONFIG_SCHEMA = 17 as const

export type Sha256Digest = `sha256:${string}`

export type DeploymentManifest = Readonly<{
  schema: typeof DEPLOYMENT_MANIFEST_SCHEMA
  builtAt: string
  packageVersion: string
  configSchema: number
  sourceCommit: string | null
  /** true when install ran against a dirty git tree (--allow-dirty) */
  sourceDirty: boolean
  /** Deterministic provenance of commit + tree + dirty diff (if any) */
  sourceHash: Sha256Digest
  cliHash: Sha256Digest
  configModuleHash: Sha256Digest
}>

function sha256Digest(body: Buffer | string): Sha256Digest {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`
}

function sha256File(path: string): Sha256Digest {
  return sha256Digest(readFileSync(path))
}

function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value)
}

/**
 * Hash of commit + HEAD tree + dirty flag + porcelain/diff payload.
 * Clean trees yield a stable hash for the same commit; dirty trees fold in
 * status + diff so two dirty builds with different edits diverge.
 */
export function computeSourceHash(args: Readonly<{
  sourceCommit: string | null
  sourceDirty: boolean
  treeOid: string | null
  porcelain: string
  diff: string
}>): Sha256Digest {
  const h = createHash("sha256")
  h.update(`commit:${args.sourceCommit ?? "null"}\n`)
  h.update(`tree:${args.treeOid ?? "null"}\n`)
  h.update(`dirty:${args.sourceDirty ? "1" : "0"}\n`)
  h.update(args.porcelain)
  h.update("\n---\n")
  h.update(args.diff)
  return `sha256:${h.digest("hex")}`
}

export function defaultRuntimeRoot(): string {
  return join(homedir(), ".trenchcoat", "runtime")
}

export function deploymentManifestPath(runtimeRoot = defaultRuntimeRoot()): string {
  return join(runtimeRoot, "deployment.json")
}

export function parseDeploymentManifest(raw: unknown): DeploymentManifest | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  if (o["schema"] !== DEPLOYMENT_MANIFEST_SCHEMA) return undefined
  if (typeof o["builtAt"] !== "string" || o["builtAt"].length === 0) return undefined
  if (typeof o["packageVersion"] !== "string" || o["packageVersion"].length === 0) return undefined
  if (typeof o["configSchema"] !== "number" || !Number.isInteger(o["configSchema"])) return undefined
  const sourceCommit = o["sourceCommit"]
  if (!(sourceCommit === null || (typeof sourceCommit === "string" && /^[0-9a-f]{7,64}$/iu.test(sourceCommit)))) {
    return undefined
  }
  if (typeof o["sourceDirty"] !== "boolean") return undefined
  if (!isSha256Digest(o["sourceHash"])) return undefined
  if (!isSha256Digest(o["cliHash"])) return undefined
  if (!isSha256Digest(o["configModuleHash"])) return undefined
  return {
    schema: DEPLOYMENT_MANIFEST_SCHEMA,
    builtAt: o["builtAt"],
    packageVersion: o["packageVersion"],
    configSchema: o["configSchema"],
    sourceCommit: sourceCommit === null ? null : sourceCommit.toLowerCase(),
    sourceDirty: o["sourceDirty"],
    sourceHash: o["sourceHash"],
    cliHash: o["cliHash"],
    configModuleHash: o["configModuleHash"],
  }
}

export function buildDeploymentManifest(args: Readonly<{
  runtimeRoot: string
  builtAt: string
  packageVersion: string
  configSchema: number
  sourceCommit?: string | null
  sourceDirty: boolean
  sourceHash: Sha256Digest
}>): DeploymentManifest {
  const cliPath = join(args.runtimeRoot, "dist", "cli.js")
  const configPath = join(args.runtimeRoot, "dist", "lib", "config.js")
  if (!existsSync(cliPath) || !existsSync(configPath)) {
    throw new Error("runtime dist artifacts missing for deployment manifest")
  }
  return {
    schema: DEPLOYMENT_MANIFEST_SCHEMA,
    builtAt: args.builtAt,
    packageVersion: args.packageVersion,
    configSchema: args.configSchema,
    sourceCommit: args.sourceCommit ?? null,
    sourceDirty: args.sourceDirty,
    sourceHash: args.sourceHash,
    cliHash: sha256File(cliPath),
    configModuleHash: sha256File(configPath),
  }
}

export async function writeDeploymentManifest(
  runtimeRoot: string,
  manifest: DeploymentManifest,
): Promise<void> {
  await writeAtomicFile(
    deploymentManifestPath(runtimeRoot),
    `${JSON.stringify(manifest, null, 2)}\n`,
    0o600,
  )
}

export function loadDeploymentManifest(
  runtimeRoot = defaultRuntimeRoot(),
): DeploymentManifest | undefined {
  const path = deploymentManifestPath(runtimeRoot)
  if (!existsSync(path)) return undefined
  try {
    return parseDeploymentManifest(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return undefined
  }
}

const COMMIT_SHA = /^[a-f0-9]{7,64}$/i

/**
 * Provenance for audit epoch manifests. Prefer the installed runtime commit;
 * fall back to git HEAD under TRENCHCOAT_REPO_ROOT / cwd. Never returns "local".
 */
export function resolveAuditCodeCommit(opts?: Readonly<{
  runtimeRoot?: string
  repoRoot?: string
}>): string {
  const deployed = loadDeploymentManifest(opts?.runtimeRoot)?.sourceCommit
  if (deployed && COMMIT_SHA.test(deployed)) return deployed.toLowerCase()

  const repoRoot = opts?.repoRoot
    ?? (process.env["TRENCHCOAT_REPO_ROOT"]?.trim() || process.cwd())
  const out = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  const sha = (out.stdout ?? "").trim().toLowerCase()
  if (out.status !== 0 || !COMMIT_SHA.test(sha)) {
    throw new Error(
      `cannot resolve audit codeCommit from deployment or git (${repoRoot})`,
    )
  }
  return sha
}

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { writeAtomicFile } from "./fs-atomic.js"

export const DEPLOYMENT_MANIFEST_SCHEMA = 1 as const

export type DeploymentManifest = Readonly<{
  schema: typeof DEPLOYMENT_MANIFEST_SCHEMA
  builtAt: string
  packageVersion: string
  configSchema: number
  sourceCommit: string | null
  cliHash: `sha256:${string}`
  configModuleHash: `sha256:${string}`
}>

function sha256File(path: string): `sha256:${string}` {
  const body = readFileSync(path)
  return `sha256:${createHash("sha256").update(body).digest("hex")}`
}

export function defaultRuntimeRoot(): string {
  return join(homedir(), ".trenchcoat", "runtime")
}

export function deploymentManifestPath(runtimeRoot = defaultRuntimeRoot()): string {
  return join(runtimeRoot, "deployment.json")
}

export function buildDeploymentManifest(args: Readonly<{
  runtimeRoot: string
  builtAt: string
  packageVersion: string
  configSchema: number
  sourceCommit?: string | null
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
  const raw = JSON.parse(readFileSync(path, "utf8")) as DeploymentManifest
  if (raw.schema !== DEPLOYMENT_MANIFEST_SCHEMA) return undefined
  return raw
}

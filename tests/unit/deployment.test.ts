import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEPLOYMENT_CONFIG_SCHEMA,
  DEPLOYMENT_MANIFEST_SCHEMA,
  buildDeploymentManifest,
  computeSourceHash,
  loadDeploymentManifest,
  parseDeploymentManifest,
  writeDeploymentManifest,
} from "../../src/lib/deployment.js"

const HASH_A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const HASH_B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const HASH_C = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
const COMMIT = "c050b91a1b2c3d4e5f60718293a4b5c6d7e8f901"

function validRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: DEPLOYMENT_MANIFEST_SCHEMA,
    builtAt: "2026-07-19T12:00:00Z",
    packageVersion: "0.1.0",
    configSchema: DEPLOYMENT_CONFIG_SCHEMA,
    sourceCommit: COMMIT,
    sourceDirty: false,
    sourceHash: HASH_A,
    cliHash: HASH_B,
    configModuleHash: HASH_C,
    ...overrides,
  }
}

describe("parseDeploymentManifest", () => {
  it("accepts a complete schema-2 manifest", () => {
    const parsed = parseDeploymentManifest(validRaw())
    expect(parsed).toEqual({
      schema: 2,
      builtAt: "2026-07-19T12:00:00Z",
      packageVersion: "0.1.0",
      configSchema: 9,
      sourceCommit: COMMIT,
      sourceDirty: false,
      sourceHash: HASH_A,
      cliHash: HASH_B,
      configModuleHash: HASH_C,
    })
  })

  it("accepts null sourceCommit and dirty=true", () => {
    const parsed = parseDeploymentManifest(validRaw({
      sourceCommit: null,
      sourceDirty: true,
    }))
    expect(parsed?.sourceCommit).toBeNull()
    expect(parsed?.sourceDirty).toBe(true)
  })

  it("rejects legacy schema-1 manifests missing provenance fields", () => {
    expect(parseDeploymentManifest({
      schema: 1,
      builtAt: "2026-07-19T12:00:00Z",
      packageVersion: "0.1.0",
      configSchema: 8,
      sourceCommit: COMMIT,
      cliHash: HASH_B,
      configModuleHash: HASH_C,
    })).toBeUndefined()
  })

  it("rejects missing sourceDirty / sourceHash / bad digests", () => {
    expect(parseDeploymentManifest(validRaw({ sourceDirty: undefined }))).toBeUndefined()
    expect(parseDeploymentManifest(validRaw({ sourceHash: "not-a-hash" }))).toBeUndefined()
    expect(parseDeploymentManifest(validRaw({ cliHash: "sha256:short" }))).toBeUndefined()
    expect(parseDeploymentManifest(validRaw({ sourceCommit: "not-hex!!" }))).toBeUndefined()
    expect(parseDeploymentManifest(null)).toBeUndefined()
    expect(parseDeploymentManifest("x")).toBeUndefined()
  })
})

describe("computeSourceHash", () => {
  it("is stable for identical clean inputs and diverges when dirty", () => {
    const clean = computeSourceHash({
      sourceCommit: COMMIT,
      sourceDirty: false,
      treeOid: "deadbeef".repeat(5),
      porcelain: "",
      diff: "",
    })
    expect(clean).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(computeSourceHash({
      sourceCommit: COMMIT,
      sourceDirty: false,
      treeOid: "deadbeef".repeat(5),
      porcelain: "",
      diff: "",
    })).toBe(clean)

    const dirty = computeSourceHash({
      sourceCommit: COMMIT,
      sourceDirty: true,
      treeOid: "deadbeef".repeat(5),
      porcelain: " M src/lib/deployment.ts\n",
      diff: "diff --git a/src/lib/deployment.ts b/src/lib/deployment.ts\n",
    })
    expect(dirty).not.toBe(clean)
  })
})

describe("buildDeploymentManifest / loadDeploymentManifest", () => {
  it("hashes dist artifacts and round-trips via write/load", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-deploy-"))
    mkdirSync(join(root, "dist", "lib"), { recursive: true })
    writeFileSync(join(root, "dist", "cli.js"), "export const cli = 1\n")
    writeFileSync(join(root, "dist", "lib", "config.js"), "export const cfg = 1\n")

    const sourceHash = computeSourceHash({
      sourceCommit: COMMIT,
      sourceDirty: true,
      treeOid: "aa".repeat(20),
      porcelain: " M file\n",
      diff: "patch",
    })
    const built = buildDeploymentManifest({
      runtimeRoot: root,
      builtAt: "2026-07-19T12:00:00Z",
      packageVersion: "0.2.0",
      configSchema: DEPLOYMENT_CONFIG_SCHEMA,
      sourceCommit: COMMIT,
      sourceDirty: true,
      sourceHash,
    })
    expect(built.schema).toBe(2)
    expect(built.sourceDirty).toBe(true)
    expect(built.sourceHash).toBe(sourceHash)
    expect(built.cliHash).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(built.configModuleHash).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(built.cliHash).not.toBe(built.configModuleHash)

    await writeDeploymentManifest(root, built)
    expect(loadDeploymentManifest(root)).toEqual(built)
  })
})

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { sha256Json } from "../lib/canonical-json.js"
import {
  HarnessImproverConfigSchema,
  IMPROVER_CONFIG_ALLOWLIST_PATH,
  type HarnessImproverConfig,
} from "../contracts/schemas.js"

export const DEFAULT_IMPROVER_CONFIG: HarnessImproverConfig = HarnessImproverConfigSchema.parse({
  schema: 1,
  configVersion: "improver-v1",
  mining: {
    minClusterSize: 5,
    maxClusters: 8,
    maxKeepPatterns: 3,
    maxEvidencePerPattern: 16,
    signalKeyPrefixes: ["confidence", "clusters", "role:", "dex:"],
  },
  propose: {
    weakMetricPriority: {
      hitRate: 1,
      ignoreMissRate: 0.8,
      calibrationBrier: 0.6,
      paperPnlCostAdjusted: 0.4,
    },
    maxRationaleChars: 500,
  },
  planAddendum: "",
})

export function improverConfigPath(repoRoot: string): string {
  return join(repoRoot, IMPROVER_CONFIG_ALLOWLIST_PATH)
}

export function improverConfigHash(config: HarnessImproverConfig): `sha256:${string}` {
  return sha256Json(config as never)
}

/** Read repo config or return defaults when absent; malformed files throw. */
export function loadImproverConfig(repoRoot: string): HarnessImproverConfig {
  const path = improverConfigPath(repoRoot)
  if (!existsSync(path)) return DEFAULT_IMPROVER_CONFIG
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown
  return HarnessImproverConfigSchema.parse(raw)
}

export async function saveImproverConfig(
  repoRoot: string,
  config: HarnessImproverConfig,
): Promise<void> {
  const parsed = HarnessImproverConfigSchema.parse(config)
  await writeAtomicFile(
    improverConfigPath(repoRoot),
    `${JSON.stringify(parsed, null, 2)}\n`,
  )
}

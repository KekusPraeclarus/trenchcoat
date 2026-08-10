import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { DecisionBundleSchema } from "../contracts/schemas.js"
import { archiveLayout } from "../lib/archive.js"
import type { DecisionSignalLookup, PolicyVerdictLookup } from "./aggregate.js"

/**
 * Read archived decision bundles so a feedback dataset can carry decision-time
 * signals. Only sealed host records are used; no live state is read.
 */

type BundleFacts = Readonly<{
  signals: Readonly<Record<string, number>>
  verdict: "track" | "drop" | "ignore" | "revisit"
}>

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function indexBundles(archiveRoot: string): Map<string, BundleFacts> {
  const layout = archiveLayout(archiveRoot)
  const index = new Map<string, BundleFacts>()
  if (!existsSync(layout.decisions)) return index
  for (const name of readdirSync(layout.decisions)) {
    if (!name.endsWith(".json")) continue
    let parsed
    try {
      parsed = DecisionBundleSchema.parse(
        JSON.parse(readFileSync(join(layout.decisions, name), "utf8")),
      )
    } catch {
      continue
    }
    if (Object.keys(parsed.signals).length === 0) continue
    const verdict = parsed.card.verdict
    if (
      verdict !== "track" && verdict !== "drop"
      && verdict !== "ignore" && verdict !== "revisit"
    ) continue
    const facts: BundleFacts = { signals: parsed.signals, verdict }
    // Broadcast subjects appear as chain:address or as the display symbol
    const identity = parsed.card.identity
    const subjects = [
      parsed.decisionId,
      ...(identity ? [`${identity.chain}:${identity.tokenAddress}`] : []),
      ...(identity ? [identity.symbolDisplay] : []),
    ]
    for (const subject of subjects) {
      index.set(`${parsed.runId}|${normalize(subject)}`, facts)
    }
  }
  return index
}

export function decisionBundleLookups(archiveRoot: string): Readonly<{
  signals: DecisionSignalLookup
  verdicts: PolicyVerdictLookup
}> {
  const index = indexBundles(archiveRoot)
  const find = (args: Readonly<{ runId: string; subject: string }>) =>
    index.get(`${args.runId}|${normalize(args.subject)}`)
  return {
    signals: (args) => find(args)?.signals,
    verdicts: (args) => find(args)?.verdict,
  }
}

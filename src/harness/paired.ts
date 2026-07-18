import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { sha256Json, type JsonValue } from "../lib/canonical-json.js"
import { harnessRoot } from "./canary.js"
import {
  PairedEpisodeRecordSchema,
  SafeIdSchema,
  type PairedEpisodeRecord,
} from "../contracts/schemas.js"

export function pairedDir(archiveRoot: string): string {
  return join(harnessRoot(archiveRoot), "paired")
}

export function pairedEpisodePath(archiveRoot: string, episodeId: string): string {
  return join(pairedDir(archiveRoot), `${SafeIdSchema.parse(episodeId)}.json`)
}

/** Canonical hash of a proposal-like object, order independent. */
export function proposalHash(proposal: JsonValue): `sha256:${string}` {
  return sha256Json(proposal)
}

export type RecordPairedInput = Readonly<{
  archiveRoot: string
  episodeId: string
  runId: string
  frozenInboxHash: `sha256:${string}`
  candidatePolicyVersion: string
  baselinePolicyVersion: string
  // proposal-like objects both decided on the same frozen inbox
  candidateProposal?: JsonValue
  baselineProposal?: JsonValue
  mature?: boolean
  metricDelta?: Readonly<Record<string, number>>
  recordedAt: string
}>

/**
 * Record one paired canary episode. Candidate and baseline are decided from the
 * same frozenInboxHash. candidateMutated is derived purely from a hash mismatch
 * between the two proposals, and baselineMutated is always false because the
 * shadow baseline never writes state.
 */
export async function recordPairedEpisode(
  input: RecordPairedInput,
): Promise<PairedEpisodeRecord> {
  const candidateHash = input.candidateProposal !== undefined
    ? proposalHash(input.candidateProposal)
    : undefined
  const baselineHash = input.baselineProposal !== undefined
    ? proposalHash(input.baselineProposal)
    : undefined

  const candidateMutated = candidateHash !== undefined
    && baselineHash !== undefined
    && candidateHash !== baselineHash

  const record = PairedEpisodeRecordSchema.parse({
    schema: 1,
    episodeId: input.episodeId,
    runId: input.runId,
    frozenInboxHash: input.frozenInboxHash,
    candidatePolicyVersion: input.candidatePolicyVersion,
    baselinePolicyVersion: input.baselinePolicyVersion,
    ...(candidateHash ? { candidateProposalHash: candidateHash } : {}),
    ...(baselineHash ? { baselineProposalHash: baselineHash } : {}),
    candidateMutated,
    baselineMutated: false,
    mature: input.mature ?? false,
    metricDelta: input.metricDelta ?? {},
    recordedAt: input.recordedAt,
  })

  await writeAtomicFile(
    pairedEpisodePath(input.archiveRoot, record.episodeId),
    `${JSON.stringify(record, null, 2)}\n`,
  )
  return record
}

export function loadPairedEpisode(
  archiveRoot: string,
  episodeId: string,
): PairedEpisodeRecord | undefined {
  const path = pairedEpisodePath(archiveRoot, episodeId)
  if (!existsSync(path)) return undefined
  return PairedEpisodeRecordSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

export function countMaturePaired(archiveRoot: string): number {
  const dir = pairedDir(archiveRoot)
  if (!existsSync(dir)) return 0
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => PairedEpisodeRecordSchema.parse(
      JSON.parse(readFileSync(join(dir, name), "utf8")),
    ))
    .filter((record) => record.mature)
    .length
}

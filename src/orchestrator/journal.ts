import { sha256Json } from "../lib/canonical-json.js"
import { assertRunId } from "../lib/run-id.js"

export const RUN_PHASES = [
  "created",
  "collected",
  "agent-checked",
  "integrity-checked",
  "host-prepared",
  "committed",
  "alpha-purged",
  "events-staged",
  "complete",
] as const

export type RunPhase = typeof RUN_PHASES[number]

export type RunJournal = Readonly<{
  schema: 1
  runId: string
  phase: RunPhase
  phaseHashes: Readonly<Partial<Record<RunPhase, `sha256:${string}`>>>
  sideEffects: Readonly<Record<string, `sha256:${string}`>>
}>

export type SideEffectKind =
  | "alpha-purge"
  | "decision-bundle"
  | "ledger-position"
  | "outbox-delivery"
  | "router-event"
  | "wallet-lifecycle"
  | "source-call"
  | "git-commit"

const SHA256 = /^sha256:[a-f0-9]{64}$/

function assertHash(hash: string): asserts hash is `sha256:${string}` {
  if (!SHA256.test(hash)) {
    throw new TypeError("Phase hash is invalid")
  }
}

export function createRunJournal(runId: string): RunJournal {
  assertRunId(runId)
  return Object.freeze({
    schema: 1,
    runId,
    phase: "created",
    phaseHashes: Object.freeze({}),
    sideEffects: Object.freeze({}),
  })
}

export function advanceRunJournal(
  journal: RunJournal,
  phase: RunPhase,
  phaseHash: `sha256:${string}`,
): RunJournal {
  assertRunId(journal.runId)
  assertHash(phaseHash)

  const currentIndex = RUN_PHASES.indexOf(journal.phase)
  const nextIndex = RUN_PHASES.indexOf(phase)

  if (nextIndex < 0) {
    throw new TypeError("Run phase is invalid")
  }

  if (nextIndex === currentIndex) {
    const existingHash = journal.phaseHashes[phase]
    if (existingHash === phaseHash) {
      return journal
    }
    throw new Error(`Conflicting replay of run phase ${phase}`)
  }

  if (nextIndex !== currentIndex + 1) {
    throw new Error(`Run phase must advance exactly once from ${journal.phase}`)
  }

  return Object.freeze({
    ...journal,
    phase,
    phaseHashes: Object.freeze({
      ...journal.phaseHashes,
      [phase]: phaseHash,
    }),
  })
}

export function sideEffectKey(
  runId: string,
  kind: SideEffectKind,
  payloadHash: `sha256:${string}`,
): `sha256:${string}` {
  assertRunId(runId)
  assertHash(payloadHash)
  return sha256Json({ runId, kind, payloadHash })
}

export function recordSideEffect(
  journal: RunJournal,
  key: `sha256:${string}`,
  payloadHash: `sha256:${string}`,
): RunJournal {
  assertHash(key)
  assertHash(payloadHash)
  const existing = journal.sideEffects[key]
  if (existing !== undefined) {
    if (existing === payloadHash) return journal
    throw new Error(`Conflicting side-effect replay for ${key}`)
  }
  return Object.freeze({
    ...journal,
    sideEffects: Object.freeze({
      ...journal.sideEffects,
      [key]: payloadHash,
    }),
  })
}

export function hasSideEffect(journal: RunJournal, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(journal.sideEffects, key)
}

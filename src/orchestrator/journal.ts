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

export type RunStatus = "running" | "complete" | "failed"

export type RunFailure = Readonly<{
  lastPhase: RunPhase
  code: string
  message: string
  failedAt: string
}>

export type RunJournal = Readonly<{
  schema: 1
  runId: string
  phase: RunPhase
  status: RunStatus
  phaseHashes: Readonly<Partial<Record<RunPhase, `sha256:${string}`>>>
  sideEffects: Readonly<Record<string, `sha256:${string}`>>
  failure?: RunFailure
}>

export type SideEffectKind =
  | "alpha-purge"
  | "archive-sealed"
  | "decision-bundle"
  | "ledger-position"
  | "outbox-delivery"
  | "router-event"
  | "wallet-lifecycle"
  | "source-call"
  | "state-sealed"
  | "git-commit"

const SHA256 = /^sha256:[a-f0-9]{64}$/
const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const SECRETISH = /(api[_-]?key|token|secret|password|mnemonic|hmac|bearer|authorization)/iu

function assertHash(hash: string): asserts hash is `sha256:${string}` {
  if (!SHA256.test(hash)) {
    throw new TypeError("Phase hash is invalid")
  }
}

export function sanitizeFailureMessage(message: string): string {
  const clipped = message.replace(/\s+/gu, " ").trim().slice(0, 280)
  if (!clipped) return "run failed"
  if (SECRETISH.test(clipped)) return "run failed (details redacted)"
  return clipped
}

/**
 * Map a thrown error message to a journal failure code.
 * Avoid bare `config` — Playwright launch logs include flags like
 * `disable-field-trial-config` and must not become config-error.
 */
export function classifyRunFailureCode(message: string): string {
  if (/workspace lock/iu.test(message)) return "lock-held"
  if (/Conflicting (replay|side-effect)/iu.test(message)) return "journal-conflict"
  if (
    /Target (?:page|context|browser) has been closed|browser has been closed/iu.test(message)
  ) {
    return "collector-error"
  }
  if (
    /invalid config|config schema|configSchema|schema validation|migrate(?:Config| schema)?/iu
      .test(message)
  ) {
    return "config-error"
  }
  if (/Twitter|needs headful|re-auth/iu.test(message)) return "collector-auth"
  if (/Cursor CLI|session failed/iu.test(message)) return "agent-error"
  return "run-error"
}

export function createRunJournal(runId: string): RunJournal {
  assertRunId(runId)
  return Object.freeze({
    schema: 1,
    runId,
    phase: "created",
    status: "running",
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
  if (journal.status === "failed") {
    throw new Error(`Cannot advance failed run ${journal.runId}`)
  }

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

  const status: RunStatus = phase === "complete" ? "complete" : "running"
  const { failure: _drop, ...rest } = journal
  return Object.freeze({
    ...rest,
    phase,
    status,
    phaseHashes: Object.freeze({
      ...journal.phaseHashes,
      [phase]: phaseHash,
    }),
    ...(status === "complete" || !journal.failure ? {} : { failure: journal.failure }),
  })
}

export function markRunFailed(
  journal: RunJournal,
  args: Readonly<{
    code: string
    message: string
    failedAt: string
  }>,
): RunJournal {
  assertRunId(journal.runId)
  if (!SAFE_CODE.test(args.code)) {
    throw new TypeError("Failure code is invalid")
  }
  if (journal.status === "complete") {
    throw new Error(`Cannot fail completed run ${journal.runId}`)
  }
  if (journal.status === "failed" && journal.failure) {
    return journal
  }
  return Object.freeze({
    ...journal,
    status: "failed",
    failure: Object.freeze({
      lastPhase: journal.phase,
      code: args.code,
      message: sanitizeFailureMessage(args.message),
      failedAt: args.failedAt,
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

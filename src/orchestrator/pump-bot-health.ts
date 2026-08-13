import type {
  PumpBotHealth,
  PumpEngagementReceipt,
} from "../contracts/schemas.js"
import { PumpBotHealthSchema } from "../contracts/schemas.js"
import type { StateStore } from "../lib/state.js"

export function emptyPumpBotHealth(nowIso: string): PumpBotHealth {
  return {
    schema: 1,
    updatedAt: nowIso,
    consecutiveFailures: 0,
  }
}

export const PUMP_BOT_HEALTH_ESCALATION_THRESHOLD = 3

export type PumpBotHealthEscalation = Readonly<{
  escalate: boolean
  consecutiveFailures: number
  threshold: number
  lastError?: string
}>

export function pumpBotHealthEscalation(
  health: PumpBotHealth,
  threshold: number = PUMP_BOT_HEALTH_ESCALATION_THRESHOLD,
): PumpBotHealthEscalation {
  return {
    escalate: health.consecutiveFailures >= threshold,
    consecutiveFailures: health.consecutiveFailures,
    threshold,
    ...(health.lastFailure?.error ? { lastError: health.lastFailure.error } : {}),
  }
}

export function isAllAmbiguousPumpBatch(receipts: readonly PumpEngagementReceipt[]): boolean {
  return receipts.length > 0 && receipts.every((receipt) => receipt.ambiguous)
}

export function transitionPumpBotHealth(args: Readonly<{
  current: PumpBotHealth
  nowIso: string
  runId: string
  receipts: readonly PumpEngagementReceipt[]
}>): PumpBotHealth {
  if (args.receipts.length === 0) return args.current

  const verified = args.receipts.filter((receipt) => receipt.verified && !receipt.ambiguous)
  const failed = args.receipts.filter((receipt) => !receipt.verified || receipt.ambiguous)

  if (verified.length > 0) {
    const last = verified[verified.length - 1]!
    const lastFail = failed[failed.length - 1]
    return PumpBotHealthSchema.parse({
      schema: 1,
      updatedAt: args.nowIso,
      consecutiveFailures: 0,
      lastVerifiedAction: {
        action: last.action,
        target: last.target,
        runId: args.runId,
        attemptedAt: last.attemptedAt,
      },
      ...(lastFail
        ? {
          lastFailure: {
            action: lastFail.action,
            target: lastFail.target,
            runId: args.runId,
            attemptedAt: lastFail.attemptedAt,
            error: lastFail.error
              ?? lastFail.verificationError
              ?? lastFail.attemptError
              ?? "post-action verification failed",
            ambiguous: lastFail.ambiguous,
          },
        }
        : {}),
    })
  }

  const lastFail = failed[failed.length - 1]
  return PumpBotHealthSchema.parse({
    schema: 1,
    updatedAt: args.nowIso,
    consecutiveFailures: args.current.consecutiveFailures + 1,
    lastVerifiedAction: args.current.lastVerifiedAction,
    ...(lastFail
      ? {
        lastFailure: {
          action: lastFail.action,
          target: lastFail.target,
          runId: args.runId,
          attemptedAt: lastFail.attemptedAt,
          error: lastFail.error
            ?? lastFail.verificationError
            ?? lastFail.attemptError
            ?? "post-action verification failed",
          ambiguous: lastFail.ambiguous,
        },
      }
      : {}),
  })
}

export async function recordPumpBotHealth(args: Readonly<{
  state: StateStore
  nowIso: string
  runId: string
  receipts: readonly PumpEngagementReceipt[]
}>): Promise<PumpBotHealth> {
  const current = args.state.loadPumpBotHealth(args.nowIso)
  const next = transitionPumpBotHealth({
    current,
    nowIso: args.nowIso,
    runId: args.runId,
    receipts: args.receipts,
  })
  if (next !== current) {
    await args.state.savePumpBotHealth(next)
  }
  return next
}

export async function recoverPumpBotHealth(args: Readonly<{
  state: StateStore
  nowIso: string
}>): Promise<PumpBotHealth> {
  const current = args.state.loadPumpBotHealth(args.nowIso)
  const next = PumpBotHealthSchema.parse({
    schema: 1,
    updatedAt: args.nowIso,
    consecutiveFailures: 0,
    lastVerifiedAction: current.lastVerifiedAction,
    lastFailure: current.lastFailure,
  })
  await args.state.savePumpBotHealth(next)
  return next
}

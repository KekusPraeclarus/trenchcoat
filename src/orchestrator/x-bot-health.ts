import type {
  XBotHealth,
  XEngagementReceipt,
} from "../contracts/schemas.js"
import { XBotHealthSchema } from "../contracts/schemas.js"
import type { StateStore } from "../lib/state.js"

export function emptyXBotHealth(nowIso: string): XBotHealth {
  return {
    schema: 1,
    updatedAt: nowIso,
    consecutiveFailures: 0,
  }
}

// Consecutive verification failures before the executor is considered unhealthy
// and engagement should pause for operator attention rather than keep retrying
// against selectors X may have changed.
export const X_BOT_HEALTH_ESCALATION_THRESHOLD = 3

export type XBotHealthEscalation = Readonly<{
  escalate: boolean
  consecutiveFailures: number
  threshold: number
  lastError?: string
}>

export function xBotHealthEscalation(
  health: XBotHealth,
  threshold: number = X_BOT_HEALTH_ESCALATION_THRESHOLD,
): XBotHealthEscalation {
  return {
    escalate: health.consecutiveFailures >= threshold,
    consecutiveFailures: health.consecutiveFailures,
    threshold,
    ...(health.lastFailure?.error ? { lastError: health.lastFailure.error } : {}),
  }
}

export function transitionXBotHealth(args: Readonly<{
  current: XBotHealth
  nowIso: string
  runId: string
  receipts: readonly XEngagementReceipt[]
}>): XBotHealth {
  if (args.receipts.length === 0) return args.current

  const verified = args.receipts.filter((receipt) => receipt.verified && !receipt.ambiguous)
  const failed = args.receipts.filter((receipt) => !receipt.verified || receipt.ambiguous)

  if (verified.length > 0) {
    const last = verified[verified.length - 1]!
    const lastFail = failed[failed.length - 1]
    return XBotHealthSchema.parse({
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
            error: lastFail.error ?? "post-action verification failed",
            ambiguous: lastFail.ambiguous,
          },
        }
        : args.current.lastFailure
          ? { lastFailure: args.current.lastFailure }
          : {}),
    })
  }

  const firstFail = failed[0]!
  return XBotHealthSchema.parse({
    schema: 1,
    updatedAt: args.nowIso,
    consecutiveFailures: args.current.consecutiveFailures + 1,
    ...(args.current.lastVerifiedAction
      ? { lastVerifiedAction: args.current.lastVerifiedAction }
      : {}),
    lastFailure: {
      action: firstFail.action,
      target: firstFail.target,
      runId: args.runId,
      attemptedAt: firstFail.attemptedAt,
      error: firstFail.error ?? "post-action verification failed",
      ambiguous: firstFail.ambiguous,
    },
  })
}

export async function recordEngagementExecutionHealth(args: Readonly<{
  state: StateStore
  nowIso: string
  runId: string
  receipts: readonly XEngagementReceipt[]
}>): Promise<XBotHealth> {
  const current = args.state.loadXBotHealth(args.nowIso)
  const next = transitionXBotHealth({
    current,
    nowIso: args.nowIso,
    runId: args.runId,
    receipts: args.receipts,
  })
  if (next.updatedAt !== current.updatedAt
    || next.consecutiveFailures !== current.consecutiveFailures
    || next.lastVerifiedAction !== current.lastVerifiedAction
    || next.lastFailure !== current.lastFailure) {
    await args.state.saveXBotHealth(next)
  }
  return next
}

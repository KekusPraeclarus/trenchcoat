import type { BroadcastItem } from "../contracts/schemas.js"

export type BudgetState = Readonly<{
  dayKey: string
  used: number
  urgentUsed: number
}>

export function dayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

export function canSendBroadcast(
  item: BroadcastItem,
  budget: BudgetState,
  limits: Readonly<{ daily_budget: number; urgent_ceiling: number }>,
): { ok: true; next: BudgetState } | { ok: false; reason: string } {
  // Discord-only daily message budget (Telegram is uncapped at ingest).
  if (item.severity === "urgent") {
    if (budget.urgentUsed >= limits.urgent_ceiling) {
      return { ok: false, reason: "urgent-ceiling" }
    }
    return {
      ok: true,
      next: { ...budget, urgentUsed: budget.urgentUsed + 1 },
    }
  }
  if (budget.used >= limits.daily_budget) {
    return { ok: false, reason: "daily-budget" }
  }
  return {
    ok: true,
    next: { ...budget, used: budget.used + 1 },
  }
}

export const VERIFICATION_RULES = Object.freeze([
  "token.up.72h",
  "token.down.72h",
  "narrative.emergence",
  "narrative.fade",
  "narrative.development",
  "rotation",
  "sentiment.collapse",
  "wallet.lifecycle",
  "wallet.convergence",
] as const)

export function isKnownVerificationRule(rule: string): boolean {
  return (VERIFICATION_RULES as readonly string[]).includes(rule)
}

export function dayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10)
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

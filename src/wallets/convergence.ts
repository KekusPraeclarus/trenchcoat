import type { WalletBuyOutcome } from "../contracts/schemas.js"

export type WalletConvergenceSignal = Readonly<{
  chain: string
  tokenAddress: string
  walletIds: readonly string[]
  windowStartIso: string
  windowEndIso: string
  firstBuyAt: string
  convergenceId: string
}>

export type WalletConvergenceOptions = Readonly<{
  minWallets: number
  windowMinutes: number
  maxTokenAgeHours: number
  nowIso: string
  /** Optional map of tokenAddress(lower) → poolCreatedAt iso */
  tokenCreatedAt?: ReadonlyMap<string, string>
  nativeOrWrap?: (tokenAddress: string) => boolean
  hash: (payload: unknown) => `sha256:${string}`
}>

/**
 * Sliding-window convergence over event-time tracking wallets.
 * Mirrors Fomo deriveConvergence but keys on walletId.
 */
export function deriveWalletBuyConvergence(
  outcomes: readonly WalletBuyOutcome[],
  opts: WalletConvergenceOptions,
): WalletConvergenceSignal[] {
  const windowMs = opts.windowMinutes * 60_000
  const maxAgeMs = opts.maxTokenAgeHours * 3_600_000
  const nowMs = Date.parse(opts.nowIso)
  const byToken = new Map<string, WalletBuyOutcome[]>()

  for (const outcome of outcomes) {
    if ((outcome.side ?? "buy") !== "buy") continue
    if (!outcome.finalized || outcome.removed || !outcome.priceable) continue
    if (outcome.walletStatusAtEvent !== "tracking") continue
    if (opts.nativeOrWrap?.(outcome.tokenAddress)) continue
    const key = `${outcome.chain}:${outcome.tokenAddress.toLowerCase()}`
    const list = byToken.get(key) ?? []
    list.push(outcome)
    byToken.set(key, list)
  }

  const signals: WalletConvergenceSignal[] = []
  for (const [key, rows] of byToken) {
    const sorted = [...rows].sort((a, b) => Date.parse(a.boughtAt) - Date.parse(b.boughtAt))
    const [chain, tokenAddress] = key.split(":") as [string, string]
    const createdAt = opts.tokenCreatedAt?.get(tokenAddress.toLowerCase())
      ?? opts.tokenCreatedAt?.get(tokenAddress)
    if (createdAt) {
      const age = nowMs - Date.parse(createdAt)
      if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) continue
    } else {
      // Fail closed when age unknown: use earliest buy as proxy only if within max age of now
      const earliest = Date.parse(sorted[0]!.boughtAt)
      if (!Number.isFinite(earliest) || nowMs - earliest > maxAgeMs) continue
    }

    for (let i = 0; i < sorted.length; i += 1) {
      const start = Date.parse(sorted[i]!.boughtAt)
      const windowEnd = start + windowMs
      const walletIds = new Set<string>()
      for (let j = i; j < sorted.length; j += 1) {
        const ts = Date.parse(sorted[j]!.boughtAt)
        if (ts > windowEnd) break
        walletIds.add(sorted[j]!.walletId)
      }
      if (walletIds.size < opts.minWallets) continue
      const ids = [...walletIds].sort()
      const firstBuyAt = sorted[i]!.boughtAt
      const windowEndIso = new Date(windowEnd).toISOString()
      const convergenceId = opts.hash({
        kind: "wallet-convergence",
        chain,
        tokenAddress,
        walletIds: ids,
        windowStart: firstBuyAt,
      })
      signals.push({
        chain,
        tokenAddress: sorted[i]!.tokenAddress,
        walletIds: ids,
        windowStartIso: firstBuyAt,
        windowEndIso,
        firstBuyAt,
        convergenceId,
      })
      break
    }
  }

  return signals.sort((a, b) => a.convergenceId.localeCompare(b.convergenceId))
}

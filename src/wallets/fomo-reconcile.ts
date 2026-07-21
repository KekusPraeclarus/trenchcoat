import { sha256Json } from "../lib/canonical-json.js"
import type { WalletRecord, WalletTransition, WalletsFile } from "../contracts/schemas.js"
import { buildWalletTransition } from "./lifecycle.js"

export const FOMO_INVALID_REASON = "invalid-fomo-profile-address" as const

export type FomoWalletReconciliation = Readonly<{
  file: WalletsFile
  excluded: readonly string[]
  dropped: readonly string[]
  transitions: readonly WalletTransition[]
  unchanged: boolean
}>

/**
 * Quarantine legacy Fomo-origin wallet records: candidates → excluded;
 * tracking/probation → one immutable dropped transition.
 */
export function reconcileInvalidFomoWallets(
  file: WalletsFile,
  nowIso: string,
  runId = "fomo-wallet-reconcile",
): FomoWalletReconciliation {
  const byId = new Map(file.wallets.map((w) => [w.walletId, { ...w }]))
  const excluded: string[] = []
  const dropped: string[] = []
  const transitions: WalletTransition[] = []
  const existingIds = new Set(file.transitions.map((t) => t.transitionId))

  for (const wallet of byId.values()) {
    if (wallet.discoveredFrom !== "fomo") continue
    if (wallet.status === "excluded" && wallet.hardExclusionReason === FOMO_INVALID_REASON) {
      continue
    }
    if (wallet.status === "candidate" || wallet.status === "excluded") {
      const next: WalletRecord = {
        ...wallet,
        status: "excluded",
        hardExcluded: true,
        hardExclusionReason: FOMO_INVALID_REASON,
        updatedAt: nowIso,
      }
      byId.set(wallet.walletId, next)
      excluded.push(wallet.walletId)
      continue
    }
    if (wallet.status === "tracking" || wallet.status === "tracking-probation") {
      const transition = buildWalletTransition({
        wallet,
        action: "dropped",
        reasonCode: FOMO_INVALID_REASON,
        reasonLine: "legacy Fomo profile address is not a trading wallet",
        occurredAt: nowIso,
        runId,
        evidenceHash: sha256Json({
          walletId: wallet.walletId,
          action: "dropped",
          reason: FOMO_INVALID_REASON,
        }),
      })
      if (!existingIds.has(transition.transitionId)) {
        transitions.push(transition)
        existingIds.add(transition.transitionId)
      }
      byId.set(wallet.walletId, {
        ...wallet,
        status: "dropped",
        droppedAt: nowIso,
        hardExcluded: true,
        hardExclusionReason: FOMO_INVALID_REASON,
        updatedAt: nowIso,
        cooldownUntil: new Date(Date.parse(nowIso) + 30 * 86_400_000).toISOString(),
      })
      dropped.push(wallet.walletId)
      continue
    }
    if (wallet.status === "dropped" && wallet.hardExclusionReason !== FOMO_INVALID_REASON) {
      byId.set(wallet.walletId, {
        ...wallet,
        hardExcluded: true,
        hardExclusionReason: FOMO_INVALID_REASON,
        updatedAt: nowIso,
      })
      excluded.push(wallet.walletId)
    }
  }

  const unchanged = excluded.length === 0 && dropped.length === 0 && transitions.length === 0
  return {
    file: {
      ...file,
      wallets: [...byId.values()].sort((a, b) => a.walletId.localeCompare(b.walletId)),
      transitions: [...file.transitions, ...transitions],
    },
    excluded,
    dropped,
    transitions,
    unchanged,
  }
}

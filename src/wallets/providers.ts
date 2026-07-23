export type WalletBuyKind = "swap-buy" | "swap-sell" | "unknown"

export type WalletProviderAction = Readonly<{
  walletAddress: string
  tokenAddress: string
  /** Epoch milliseconds */
  timestamp: number
  finalized: boolean
  removed?: boolean
  priceable: boolean
  providerEventId: string
  blockOrSlot: number
  classification: WalletBuyKind
  /** Native or allowlisted quote spent (buys) or received (sells), when known */
  quoteSpent?: Readonly<{ asset: string; amountRaw: string }>
  tokenReceivedRaw?: string
  /** Token amount sold (swap-sell) */
  tokenSoldRaw?: string
  txSender?: string
}>

export interface WalletProvider {
  readonly chain: string
  listActions(walletAddress: string, fromTimestamp: number): Promise<readonly WalletProviderAction[]>
}

function isEligibleBase(action: WalletProviderAction): boolean {
  return (
    action.finalized
    && !action.removed
    && action.priceable
    && action.providerEventId.length > 0
    && Number.isFinite(action.timestamp)
    && action.timestamp > 0
  )
}

/** Keep only finalized, non-removed, priceable swap buys */
export function eligibleWalletActions(actions: readonly WalletProviderAction[]): WalletProviderAction[] {
  return actions.filter((action) => (
    isEligibleBase(action) && action.classification === "swap-buy"
  ))
}

/** Buys and sells for copy-trade archival */
export function eligibleWalletTrades(actions: readonly WalletProviderAction[]): WalletProviderAction[] {
  return actions.filter((action) => (
    isEligibleBase(action)
    && (action.classification === "swap-buy" || action.classification === "swap-sell")
  ))
}

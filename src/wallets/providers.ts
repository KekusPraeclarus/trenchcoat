export type WalletBuyKind = "swap-buy" | "unknown"

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
  /** Native or allowlisted quote spent, when known */
  quoteSpent?: Readonly<{ asset: string; amountRaw: string }>
  tokenReceivedRaw?: string
  txSender?: string
}>

export interface WalletProvider {
  readonly chain: string
  listActions(walletAddress: string, fromTimestamp: number): Promise<readonly WalletProviderAction[]>
}

/** Keep only finalized, non-removed, priceable swap buys */
export function eligibleWalletActions(actions: readonly WalletProviderAction[]): WalletProviderAction[] {
  return actions.filter((action) => (
    action.finalized
    && !action.removed
    && action.priceable
    && action.classification === "swap-buy"
    && action.providerEventId.length > 0
    && Number.isFinite(action.timestamp)
    && action.timestamp > 0
  ))
}

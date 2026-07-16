export type WalletProviderAction = Readonly<{
  walletAddress: string
  tokenAddress: string
  timestamp: number
  finalized: boolean
  removed?: boolean
  priceable: boolean
}>

export interface WalletProvider {
  readonly chain: string
  listActions(walletAddress: string, fromTimestamp: number): Promise<readonly WalletProviderAction[]>
}

export function eligibleWalletActions(actions: readonly WalletProviderAction[]): WalletProviderAction[] {
  return actions.filter((action) => action.finalized && !action.removed && action.priceable)
}

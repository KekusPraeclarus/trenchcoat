export type TxSide =
  | "buy"
  | "sell"
  | "transfer"
  | "receive"
  | "mint"
  | "position"
  | "unknown"

export type TxParserId =
  | "cielo_swap"
  | "cielo_transfer"
  | "cielo_receive"
  | "cielo_mint"
  | "asset_flow"
  | "hypercore_position"
  | "hypercore_twap"
  | "human_lossy"

export type TxConfidence = "high" | "medium" | "low"

export type TxEvent = Readonly<{
  parser: TxParserId
  messageId: string
  channelId: string
  receivedAt: string
  actor: string
  chain?: string
  side: TxSide
  tokenContract?: string
  tokenSymbol?: string
  amountUsd?: string
  tokenIn?: string
  tokenOut?: string
  amountIn?: string
  amountOut?: string
  confidence: TxConfidence
  exchange?: string
  marketCap?: string
  age?: string
  txUrl?: string
  walletUrl?: string
  emojiHints?: readonly string[]
  embedColor?: number
}>

export type DiscordWalletSignal = Readonly<{
  kind: "convergence" | "sell-pressure"
  polarity: "bullish" | "bearish"
  chain?: string
  tokenContract: string
  actors: readonly string[]
  windowStart: string
  windowEnd: string
  observedAt: string
}>

export const QUOTE_ASSETS = Object.freeze(new Set([
  "SOL",
  "WSOL",
  "USDC",
  "USDT",
  "USD1",
  "ETH",
  "WETH",
  "WBNB",
  "BNB",
  "DAI",
  "USDBC",
  "USDCET",
]))

export const COLOR_BUY = 0x57f287
export const COLOR_SELL = 0xed4245
export const COLOR_MINT = 0xfee75c

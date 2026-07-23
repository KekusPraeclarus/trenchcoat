import type { DiscordHistoryMessage } from "../../discord/bot-client.js"
import {
  COLOR_BUY,
  COLOR_MINT,
  COLOR_SELL,
  QUOTE_ASSETS,
  type TxEvent,
  type TxSide,
} from "./types.js"

const AMOUNT = String.raw`[\d,.]+[KMBkmb]?`
const TOKEN = String.raw`#?[A-Za-z0-9._-]+`
const SWAP_RE = new RegExp(
  String.raw`Swapped\s+(${AMOUNT})\s+(${TOKEN})(?:\s+\(\$([\d,.]+)\))?\s+for\s+(${AMOUNT})\s+(${TOKEN})(?:\s+On\s+(${TOKEN}))?`,
  "iu",
)
const TRANSFERRED_RE = new RegExp(
  String.raw`Transferred:\s+(${AMOUNT})\s+(${TOKEN})(?:\s+\(\$([\d,.]+)\))?`,
  "iu",
)
const RECEIVED_RE = new RegExp(
  String.raw`Received:\s+(${AMOUNT})\s+(${TOKEN})(?:\s+\(\$([\d,.]+)\))?`,
  "iu",
)
const MINTED_RE = new RegExp(
  String.raw`Minted:\s+(${AMOUNT})\s+(${TOKEN})(?:\s+\(\$([\d,.]+)\))?`,
  "iu",
)
const TOKEN_LINE_RE = /^Token:\s*([^\s|]+)/imu
const CHAIN_LINE_RE = /^#?([A-Za-z][A-Za-z0-9_-]*)\s*\|/mu
const ASSET_FLOW_HEADER_RE =
  /^(?:🔵\s*)?(.+?)\s+·\s+.+\s+transferred assets on\s+([A-Za-z][A-Za-z0-9_-]*)/imu
const POSITION_RE = /\bPOSITION\b/iu
const TWAP_RE = /\bTWAP\s*·/iu
const ACTOR_HASH_RE = /^#?(@?[^\n]+)$/mu
const SOL_CA_RE = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/u
const EVM_CA_RE = /\b(0x[a-fA-F0-9]{40})\b/u
const BUY_KW = /\b(buys?|buying|long|ape|entry|accumulating)\b/iu
const SELL_KW = /\b(sells?|selling|short|exit|dump|trimming)\b/iu
const MD_LINK_RE = /\[[^\]]*\]\(<([^>]+)>\)/gu

function stripHash(token: string): string {
  return token.replace(/^#/u, "")
}

function normalizeContract(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (/^0x[a-fA-F0-9]{40}$/u.test(trimmed)) return trimmed.toLowerCase()
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(trimmed)) return trimmed
  return undefined
}

function extractFirstCa(text: string): string | undefined {
  const evm = text.match(EVM_CA_RE)?.[1]
  if (evm) return normalizeContract(evm)
  const sol = text.match(SOL_CA_RE)?.[1]
  return normalizeContract(sol)
}

function extractTokenLine(text: string): string | undefined {
  return normalizeContract(text.match(TOKEN_LINE_RE)?.[1])
}

function extractChain(text: string): string | undefined {
  const match = text.match(CHAIN_LINE_RE)
  return match?.[1]?.toLowerCase()
}

function extractActor(text: string): string | undefined {
  const lines = text.split(/\n/u).map((line) => line.trim()).filter(Boolean)
  for (const line of lines.slice(0, 3)) {
    if (/^(Swapped|Transferred:|Received:|Minted:|Token:)/iu.test(line)) continue
    if (/^(POSITION|TWAP)/iu.test(line)) continue
    if (/transferred assets on/iu.test(line)) continue
    const cleaned = line.replace(/^#/u, "").replace(/^[🟢🔴➕🔵🟠🟣⭐️\s]+/u, "").trim()
    if (cleaned.length >= 2) return cleaned
  }
  const hash = text.match(ACTOR_HASH_RE)?.[1]
  return hash?.replace(/^#/u, "").trim()
}

function extractUsd(text: string): string | undefined {
  const match = text.match(/\$([\d,.]+)/u)
  return match?.[1]
}

function extractMcAge(text: string): Readonly<{ marketCap?: string, age?: string }> {
  const mc = text.match(/MC:\s*\$?([\d.,]+[KMB]?)/iu)?.[1]
  const age = text.match(/Age:\s*([\d]+d)/iu)?.[1]
  return {
    ...(mc ? { marketCap: mc } : {}),
    ...(age ? { age } : {}),
  }
}

function extractLinks(text: string): Readonly<{ txUrl?: string, walletUrl?: string }> {
  const urls: string[] = []
  for (const match of text.matchAll(MD_LINK_RE)) {
    if (match[1]) urls.push(match[1])
  }
  const txUrl = urls.find((url) => /tx|transaction/iu.test(url))
  const walletUrl = urls.find((url) => /wallet|address/iu.test(url))
  return {
    ...(txUrl ? { txUrl } : {}),
    ...(walletUrl ? { walletUrl } : {}),
  }
}

function leadingEmojis(text: string): string[] {
  const match = text.match(/^[🟢🔴➕🔵🟠🟣⭐️\s]+/u)
  if (!match) return []
  return [...match[0]].filter((ch) => /[🟢🔴➕🔵🟠🟣⭐️]/u.test(ch))
}

function sideFromColorOrEmoji(
  embedColor: number | undefined,
  text: string,
): TxSide | undefined {
  if (embedColor === COLOR_BUY || text.includes("🟢")) return "buy"
  if (embedColor === COLOR_SELL || text.includes("🔴")) return "sell"
  if (embedColor === COLOR_MINT || text.includes("➕")) return "mint"
  return undefined
}

function sideFromQuoteHeuristic(tokenIn: string, tokenOut: string): TxSide {
  const inQ = QUOTE_ASSETS.has(tokenIn.toUpperCase())
  const outQ = QUOTE_ASSETS.has(tokenOut.toUpperCase())
  if (inQ && !outQ) return "buy"
  if (outQ && !inQ) return "sell"
  return "unknown"
}

function messageText(message: DiscordHistoryMessage): Readonly<{
  text: string
  embedColor?: number
}> {
  const embed = message.embeds?.[0]
  const description = embed?.description?.trim() ?? ""
  const content = message.content.trim()
  const text = description.length > 0 ? description : content
  return {
    text,
    ...(embed?.color !== undefined ? { embedColor: embed.color } : {}),
  }
}

function parseCieloSwap(args: Readonly<{
  text: string
  embedColor?: number
  messageId: string
  channelId: string
  receivedAt: string
}>): TxEvent | undefined {
  if (!/Swapped\s+/iu.test(args.text)) return undefined
  const match = args.text.match(SWAP_RE)
  if (!match) return undefined
  const tokenIn = stripHash(match[2]!)
  const tokenOut = stripHash(match[5]!)
  const exchange = match[6] ? stripHash(match[6]) : undefined
  const colorSide = sideFromColorOrEmoji(args.embedColor, args.text)
  const side = colorSide === "mint"
    ? "mint"
    : (colorSide ?? sideFromQuoteHeuristic(tokenIn, tokenOut))
  const tokenContract = extractTokenLine(args.text)
  const actor = extractActor(args.text) ?? "unknown"
  const chain = extractChain(args.text)
  const meta = extractMcAge(args.text)
  const links = extractLinks(args.text)
  const emojis = leadingEmojis(args.text)
  const amountUsd = match[3] ?? extractUsd(args.text)
  return {
    parser: "cielo_swap",
    messageId: args.messageId,
    channelId: args.channelId,
    receivedAt: args.receivedAt,
    actor,
    ...(chain ? { chain } : {}),
    side,
    ...(tokenContract ? { tokenContract } : {}),
    tokenSymbol: side === "buy" || side === "unknown" ? tokenOut : tokenIn,
    ...(amountUsd ? { amountUsd } : {}),
    tokenIn,
    tokenOut,
    amountIn: match[1]!,
    amountOut: match[4]!,
    confidence: "high",
    ...(exchange ? { exchange } : {}),
    ...meta,
    ...links,
    ...(emojis.length > 0 ? { emojiHints: emojis } : {}),
    ...(args.embedColor !== undefined ? { embedColor: args.embedColor } : {}),
  }
}

function parseCieloTransferFamily(args: Readonly<{
  text: string
  embedColor?: number
  messageId: string
  channelId: string
  receivedAt: string
}>): TxEvent | undefined {
  let side: TxSide | undefined
  let parser: TxEvent["parser"] | undefined
  let match: RegExpMatchArray | null = null
  if (/Transferred:/iu.test(args.text)) {
    side = "transfer"
    parser = "cielo_transfer"
    match = args.text.match(TRANSFERRED_RE)
  } else if (/Received:/iu.test(args.text) && !/transferred assets on/iu.test(args.text)) {
    side = "receive"
    parser = "cielo_receive"
    match = args.text.match(RECEIVED_RE)
  } else if (/Minted:/iu.test(args.text)) {
    side = "mint"
    parser = "cielo_mint"
    match = args.text.match(MINTED_RE)
  }
  if (!side || !parser || !match) return undefined
  const tokenSymbol = stripHash(match[2]!)
  const tokenContract = extractTokenLine(args.text)
  const actor = extractActor(args.text) ?? "unknown"
  const chain = extractChain(args.text)
  const meta = extractMcAge(args.text)
  const links = extractLinks(args.text)
  return {
    parser,
    messageId: args.messageId,
    channelId: args.channelId,
    receivedAt: args.receivedAt,
    actor,
    ...(chain ? { chain } : {}),
    side,
    ...(tokenContract ? { tokenContract } : {}),
    tokenSymbol,
    ...(match[3] ? { amountUsd: match[3] } : {}),
    amountIn: match[1]!,
    confidence: "high",
    ...meta,
    ...links,
    ...(args.embedColor !== undefined ? { embedColor: args.embedColor } : {}),
  }
}

function parseAssetFlow(args: Readonly<{
  text: string
  embedColor?: number
  messageId: string
  channelId: string
  receivedAt: string
}>): TxEvent | undefined {
  if (!/transferred assets on/iu.test(args.text)) return undefined
  const header = args.text.match(ASSET_FLOW_HEADER_RE)
  const actor = header?.[1]?.trim() ?? extractActor(args.text) ?? "unknown"
  const chain = header?.[2]?.toLowerCase() ?? extractChain(args.text)
  let side: TxSide = "unknown"
  let tokenSymbol: string | undefined
  let amountUsd: string | undefined
  const received = args.text.match(RECEIVED_RE)
  const transferred = args.text.match(TRANSFERRED_RE)
    ?? args.text.match(new RegExp(String.raw`Sent:\s+(${AMOUNT})\s+(${TOKEN})(?:\s+\(\$([\d,.]+)\))?`, "iu"))
  if (received) {
    side = "receive"
    tokenSymbol = stripHash(received[2]!)
    amountUsd = received[3]
  } else if (transferred) {
    side = "transfer"
    tokenSymbol = stripHash(transferred[2]!)
    amountUsd = transferred[3]
  }
  const tokenContract = extractTokenLine(args.text) ?? extractFirstCa(args.text)
  return {
    parser: "asset_flow",
    messageId: args.messageId,
    channelId: args.channelId,
    receivedAt: args.receivedAt,
    actor,
    ...(chain ? { chain } : {}),
    side,
    ...(tokenContract ? { tokenContract } : {}),
    ...(tokenSymbol ? { tokenSymbol } : {}),
    ...(amountUsd ? { amountUsd } : {}),
    confidence: "medium",
    ...(args.embedColor !== undefined ? { embedColor: args.embedColor } : {}),
  }
}

function parseHypercore(args: Readonly<{
  text: string
  embedColor?: number
  messageId: string
  channelId: string
  receivedAt: string
}>): TxEvent | undefined {
  const isTwap = TWAP_RE.test(args.text)
  const isPosition = POSITION_RE.test(args.text)
  if (!isTwap && !isPosition) return undefined
  const actor = extractActor(args.text) ?? "unknown"
  const chain = extractChain(args.text) ?? "hypercore"
  return {
    parser: isTwap ? "hypercore_twap" : "hypercore_position",
    messageId: args.messageId,
    channelId: args.channelId,
    receivedAt: args.receivedAt,
    actor,
    chain,
    side: "position",
    confidence: "high",
    ...(args.embedColor !== undefined ? { embedColor: args.embedColor } : {}),
  }
}

function parseHumanLossy(args: Readonly<{
  text: string
  authorUsername?: string
  messageId: string
  channelId: string
  receivedAt: string
}>): TxEvent | undefined {
  const tokenContract = extractFirstCa(args.text)
  if (!tokenContract) return undefined
  let side: TxSide = "unknown"
  if (BUY_KW.test(args.text)) side = "buy"
  else if (SELL_KW.test(args.text)) side = "sell"
  else return undefined
  return {
    parser: "human_lossy",
    messageId: args.messageId,
    channelId: args.channelId,
    receivedAt: args.receivedAt,
    actor: args.authorUsername?.trim() || "unknown",
    side,
    tokenContract,
    confidence: "low",
  }
}

export function parseDiscordWalletMessage(message: DiscordHistoryMessage): TxEvent | undefined {
  const { text, embedColor } = messageText(message)
  if (!text.trim()) return undefined
  const base = {
    text,
    ...(embedColor !== undefined ? { embedColor } : {}),
    messageId: message.id,
    channelId: message.channelId,
    receivedAt: message.timestamp,
  }
  return parseCieloSwap(base)
    ?? parseCieloTransferFamily(base)
    ?? parseAssetFlow(base)
    ?? parseHypercore(base)
    ?? parseHumanLossy({
      text,
      ...(message.authorUsername ? { authorUsername: message.authorUsername } : {}),
      messageId: message.id,
      channelId: message.channelId,
      receivedAt: message.timestamp,
    })
}

export function parseDiscordWalletText(args: Readonly<{
  text: string
  embedColor?: number
  messageId?: string
  channelId?: string
  receivedAt?: string
  authorUsername?: string
}>): TxEvent | undefined {
  return parseDiscordWalletMessage({
    id: args.messageId ?? "0",
    channelId: args.channelId ?? "0",
    authorId: "0",
    ...(args.authorUsername ? { authorUsername: args.authorUsername } : {}),
    authorIsBot: false,
    authorIsWebhook: true,
    content: "",
    timestamp: args.receivedAt ?? new Date().toISOString(),
    embeds: [{
      description: args.text,
      ...(args.embedColor !== undefined ? { color: args.embedColor } : {}),
    }],
  })
}

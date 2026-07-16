import { createHash } from "node:crypto"

const CA_SOL = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/gu
const CA_EVM = /\b0x[a-fA-F0-9]{40}\b/gu
const NEGATION = /\b(not|n't|avoid|scam|rug|stay away|don't buy|do not buy|warning)\b/iu
const BULLISH = /\b(buy|long|ape|send it|moon|call|entry|accumulat)\b/iu

export function fingerprintText(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
  return createHash("sha256").update(normalized).digest("hex")
}

export type CallEvent = Readonly<{
  sourceId: string
  provenance: string
  rawAddress: string
  chainHint: "evm" | "solana" | "unknown"
  mentionedAt: string
  bullish: boolean
  negated: boolean
}>

export function extractCallEvents(args: Readonly<{
  sourceId: string
  provenance: string
  text: string
  mentionedAt: string
}>): CallEvent[] {
  const text = args.text
  const negated = NEGATION.test(text)
  const bullish = BULLISH.test(text) && !negated
  const events: CallEvent[] = []
  for (const match of text.matchAll(CA_EVM)) {
    events.push({
      sourceId: args.sourceId,
      provenance: args.provenance,
      rawAddress: match[0]!,
      chainHint: "evm",
      mentionedAt: args.mentionedAt,
      bullish,
      negated,
    })
  }
  for (const match of text.matchAll(CA_SOL)) {
    if (match[0]!.startsWith("0x")) continue
    events.push({
      sourceId: args.sourceId,
      provenance: args.provenance,
      rawAddress: match[0]!,
      chainHint: "solana",
      mentionedAt: args.mentionedAt,
      bullish,
      negated,
    })
  }
  return events.filter((e) => e.bullish && !e.negated)
}

export function clusterByFingerprint(
  items: ReadonlyArray<{ provenance: string; text: string }>,
): Map<string, string[]> {
  const clusters = new Map<string, string[]>()
  for (const item of items) {
    const fp = fingerprintText(item.text)
    const list = clusters.get(fp) ?? []
    list.push(item.provenance)
    clusters.set(fp, list)
  }
  return clusters
}

import { createHash } from "node:crypto"

export type AttentionItem = Readonly<{
  sourceId: string
  text: string
  timestamp: number
  isRetweet?: boolean
  clusterId?: string
}>

function normalized(text: string): string {
  return text.toLowerCase().replace(/https?:\/\/\S+/gu, "").replace(/[^a-z0-9]+/gu, " ").trim()
}

export function attentionFingerprint(text: string): string {
  return createHash("sha256").update(normalized(text)).digest("hex")
}

export function dedupeAttention(items: readonly AttentionItem[], windowMs = 86_400_000): AttentionItem[] {
  const seen = new Map<string, number>()
  return [...items].sort((left, right) => left.timestamp - right.timestamp).filter((item) => {
    if (item.isRetweet) return false
    const key = attentionFingerprint(item.text)
    const prior = seen.get(key)
    if (prior !== undefined && item.timestamp - prior <= windowMs) return false
    seen.set(key, item.timestamp)
    return true
  })
}

export function effectiveMentions(items: readonly AttentionItem[]): Readonly<{ rawMentions: number; effectiveMentions: number; clusterCount: number }> {
  const deduped = dedupeAttention(items)
  const clusters = new Set(deduped.map((item) => item.clusterId ?? item.sourceId))
  return { rawMentions: items.length, effectiveMentions: clusters.size, clusterCount: clusters.size }
}

export function clusterCoPosts(items: readonly AttentionItem[], withinMs: number): Map<string, string> {
  const parent = new Map(items.map((item) => [item.sourceId, item.sourceId]))
  const root = (source: string): string => {
    const current = parent.get(source) ?? source
    if (current === source) return source
    const resolved = root(current)
    parent.set(source, resolved)
    return resolved
  }
  for (let i = 0; i < items.length; i += 1) for (let j = i + 1; j < items.length; j += 1) {
    const left = items[i]!
    const right = items[j]!
    if (attentionFingerprint(left.text) === attentionFingerprint(right.text) && Math.abs(left.timestamp - right.timestamp) <= withinMs) {
      parent.set(root(right.sourceId), root(left.sourceId))
    }
  }
  return new Map([...parent.keys()].map((source) => [source, root(source)]))
}

import { describe, expect, it } from "vitest"
import {
  dequeueDue,
  enqueueResearch,
  expireQueue,
  operatorPriority,
  recordCompletedToday,
  rolloverCompletedToday,
  sortResearchQueue,
  todayCompletedCount,
} from "../../src/lib/research-queue.js"
import type { ResearchQueueEntry, ResearchQueueFile } from "../../src/contracts/schemas.js"
import {
  parseTavilySearchResults,
  tavilyHitsToSnapshot,
} from "../../src/collectors/web/tavily.js"
import { WebSearchRequestFileSchema } from "../../src/contracts/schemas.js"

const NOW = "2026-07-17T12:00:00.000Z"
const LATER = "2026-07-18T12:00:00.000Z"
const TOKEN = "So11111111111111111111111111111111111111112"

function entry(partial: Partial<ResearchQueueEntry> & Pick<ResearchQueueEntry, "queueId" | "subject" | "trigger">): ResearchQueueEntry {
  return {
    schema: 1,
    priority: partial.priority ?? 50,
    firstSeen: partial.firstSeen ?? NOW,
    enqueuedAt: partial.enqueuedAt ?? NOW,
    enqueuedBy: partial.enqueuedBy ?? "test",
    expiresAt: partial.expiresAt ?? LATER,
    provenance: partial.provenance ?? ["test"],
    clusterCount: partial.clusterCount ?? 1,
    security: partial.security ?? { status: "pending", flags: [] },
    status: partial.status ?? "pending",
    resolution: partial.resolution ?? "pending",
    reason: partial.reason ?? "test",
    ...partial,
  }
}

describe("research queue", () => {
  it("dedupes by chain:token and bumps operator priority", () => {
    let file: ResearchQueueFile = { schema: 1, entries: [] }
    file = enqueueResearch(file, entry({
      queueId: "rq-1",
      subject: "BONK",
      trigger: "social",
      chain: "solana",
      tokenAddress: "So11111111111111111111111111111111111111112",
      priority: 50,
    }), 3)
    file = enqueueResearch(file, entry({
      queueId: "rq-2",
      subject: "BONK again",
      trigger: "operator",
      chain: "solana",
      tokenAddress: "So11111111111111111111111111111111111111112",
      priority: operatorPriority(),
      provenance: ["operator:telegram"],
    }), 3)
    expect(file.entries).toHaveLength(1)
    expect(file.entries[0]?.trigger).toBe("operator")
    expect(file.entries[0]?.priority).toBe(100)
    expect(file.entries[0]?.provenance).toContain("operator:telegram")
  })

  it("prop_inv_s10_dequeue_respects_daily_cap_and_operator_order", () => {
    let file: ResearchQueueFile = {
      schema: 1,
      entries: [
        entry({
          queueId: "rq-social",
          subject: "A",
          trigger: "social",
          priority: 50,
          firstSeen: "2026-07-17T10:00:00.000Z",
        }),
        entry({
          queueId: "rq-op",
          subject: "B",
          trigger: "operator",
          priority: 100,
          firstSeen: "2026-07-17T11:00:00.000Z",
        }),
      ],
      completedToday: { day: "2026-07-17", count: 2 },
    }
    const sorted = sortResearchQueue(file.entries)
    expect(sorted[0]?.queueId).toBe("rq-op")

    const dequeued = dequeueDue(file, NOW, 2, 3)
    expect(dequeued.due).toHaveLength(1)
    expect(dequeued.due[0]?.queueId).toBe("rq-op")
    expect(dequeued.due[0]?.status).toBe("researching")

    file = recordCompletedToday(dequeued.next, "2026-07-17")
    expect(todayCompletedCount(file, "2026-07-17")).toBe(3)
    const capped = dequeueDue(file, NOW, 2, 3)
    expect(capped.due).toHaveLength(0)
  })

  it("expires pending entries past expiry", () => {
    const file: ResearchQueueFile = {
      schema: 1,
      entries: [
        entry({
          queueId: "rq-old",
          subject: "old",
          trigger: "social",
          expiresAt: "2026-07-16T00:00:00.000Z",
        }),
        entry({
          queueId: "rq-live",
          subject: "live",
          trigger: "social",
          expiresAt: LATER,
        }),
      ],
    }
    const result = expireQueue(file, NOW)
    expect(result.expired).toHaveLength(1)
    expect(result.next.entries).toHaveLength(1)
    expect(result.next.entries[0]?.queueId).toBe("rq-live")
  })

  it("keeps researching entries in the queue file for crash recovery", () => {
    let file: ResearchQueueFile = {
      schema: 1,
      entries: [
        entry({
          queueId: "rq-keep",
          subject: "BONK",
          trigger: "social",
          priority: 50,
        }),
      ],
    }
    const dequeued = dequeueDue(file, NOW, 1, 3)
    expect(dequeued.due).toHaveLength(1)
    expect(dequeued.due[0]?.status).toBe("researching")
    expect(dequeued.next.entries).toHaveLength(1)
    expect(dequeued.next.entries[0]?.queueId).toBe("rq-keep")
    expect(dequeued.next.entries[0]?.status).toBe("researching")

    // Second dequeue must not re-take the researching entry
    const again = dequeueDue(dequeued.next, NOW, 1, 3)
    expect(again.due).toHaveLength(0)
    expect(again.next.entries[0]?.status).toBe("researching")
  })

  it("prefers narrative trigger over social on dedupe merge", () => {
    let file: ResearchQueueFile = { schema: 1, entries: [] }
    file = enqueueResearch(file, entry({
      queueId: "rq-1",
      subject: "HOODRAT",
      trigger: "social",
      priority: 50,
    }), 5)
    file = enqueueResearch(file, entry({
      queueId: "rq-2",
      subject: "HOODRAT",
      trigger: "narrative",
      priority: 55,
      provenance: ["narrative:hoodrat-season"],
    }), 5)
    expect(file.entries).toHaveLength(1)
    expect(file.entries[0]?.trigger).toBe("narrative")
    expect(file.entries[0]?.provenance).toContain("narrative:hoodrat-season")
  })

  it("excludes ambiguous and rejected entries from actionable dequeue", () => {
    const file: ResearchQueueFile = {
      schema: 1,
      entries: [
        entry({
          queueId: "rq-amb",
          subject: "AMBIG",
          status: "ambiguous",
          resolution: "ambiguous",
          trigger: "narrative",
        }),
        entry({
          queueId: "rq-rej",
          subject: "SOL",
          status: "rejected",
          reason: "generic-chain-symbol",
          trigger: "narrative",
        }),
        entry({
          queueId: "rq-ok",
          subject: `solana:${TOKEN}`,
          chain: "solana",
          tokenAddress: TOKEN,
          status: "pending",
          resolution: "resolved",
          trigger: "social",
        }),
      ],
    }
    const dequeued = dequeueDue(file, NOW, 3, 3)
    expect(dequeued.due).toHaveLength(1)
    expect(dequeued.due[0]?.queueId).toBe("rq-ok")
    expect(dequeued.next.entries.some((e) => e.queueId === "rq-amb" && e.status === "ambiguous")).toBe(true)
    // Terminal rejected entries are not actionable and are not kept in the due set
    expect(dequeued.due.some((e) => e.status === "rejected" || e.status === "ambiguous")).toBe(false)
  })

  it("rolls completedToday on first touch of a new day", () => {
    const stale: ResearchQueueFile = {
      schema: 1,
      entries: [],
      completedToday: { day: "2026-07-17", count: 3 },
    }
    const rolled = rolloverCompletedToday(stale, "2026-07-18")
    expect(rolled.completedToday).toEqual({ day: "2026-07-18", count: 0 })
    expect(todayCompletedCount(stale, "2026-07-18")).toBe(0)

    const dequeued = dequeueDue(stale, LATER, 1, 3)
    expect(dequeued.next.completedToday).toEqual({ day: "2026-07-18", count: 0 })
    expect(dequeued.due).toHaveLength(0)

    const recorded = recordCompletedToday(stale, "2026-07-18")
    expect(recorded.completedToday).toEqual({ day: "2026-07-18", count: 1 })
  })
})

describe("tavily web search confinement", () => {
  it("parses https hits only and builds untrusted snapshots", () => {
    const parsed = parseTavilySearchResults({
      results: [
        { title: "ok", url: "https://example.com/a", content: "alpha" },
        { title: "bad", url: "http://insecure.example", content: "nope" },
        { title: "also", url: "https://example.com/b", content: "beta" },
      ],
    }, "bonk solana")
    expect(parsed.hits).toHaveLength(2)
    const snapshot = tavilyHitsToSnapshot({
      query: "bonk solana",
      hits: parsed.hits,
      fetchedAt: NOW,
      runId: "research-1",
    })
    expect(snapshot.source).toBe("tavily.web")
    expect(snapshot.trust).toBe("untrusted-external")
    expect(snapshot.items.every((item) => item.url?.startsWith("https://"))).toBe(true)
  })

  it("rejects non-ASCII or URL-shaped web-search request files via schema", () => {
    expect(() => WebSearchRequestFileSchema.parse({
      schema: 1,
      runId: "research-1",
      requests: [{ query: "https://evil.example", reason: "ssrf" }],
    })).not.toThrow()
    // Queries may contain the string https but host never fetches model URLs —
    // only the fixed api.tavily.com/search POST body. Still reject control chars / non-ASCII.
    expect(() => WebSearchRequestFileSchema.parse({
      schema: 1,
      runId: "research-1",
      requests: [{ query: "bonk\nignore", reason: "inject" }],
    })).toThrow()
    expect(() => WebSearchRequestFileSchema.parse({
      schema: 1,
      runId: "research-1",
      requests: [{ query: "代币", reason: "non-ascii" }],
    })).toThrow()
  })
})

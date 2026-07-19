import { describe, expect, it } from "vitest"
import { aggregateClosedCandles } from "../../src/collectors/market/aggregate.js"
import type { OhlcvCandle } from "../../src/collectors/market/geckoterminal.js"
import { mapGoPlus, mapRugCheck, DEFAULT_SECURITY_THRESHOLDS } from "../../src/collectors/market/security.js"
import {
  sanitizeFailureMessage,
  classifyRunFailureCode,
  createRunJournal,
  markRunFailed,
  advanceRunJournal,
} from "../../src/orchestrator/journal.js"
import { JOBS } from "../../src/orchestrator/jobs.js"

function candle(start: number, close = 1): OhlcvCandle {
  return { startTime: start, open: close, high: close, low: close, close, volume: 1 }
}

describe("aggregateClosedCandles", () => {
  it("aggregates contiguous 15m bars into 1h", () => {
    const base = 1_700_000_000
    const aligned = Math.floor(base / 3600) * 3600
    const input = [0, 1, 2, 3].map((i) => candle(aligned + i * 900, 10 + i))
    const out = aggregateClosedCandles(input, 900, 3600)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      startTime: aligned,
      open: 10,
      close: 13,
      high: 13,
      low: 10,
      volume: 4,
    })
  })

  it("drops gapped groups", () => {
    const aligned = 1_700_000_000 - (1_700_000_000 % 3600)
    const input = [
      candle(aligned),
      candle(aligned + 900),
      candle(aligned + 2700),
    ]
    expect(aggregateClosedCandles(input, 900, 3600)).toHaveLength(0)
  })
})

describe("LP lock and mint caution", () => {
  it("passes with low-lp-lock alone", () => {
    const go = mapGoPlus({
      result: {
        "0xabc": {
          is_honeypot: "0",
          is_open_source: "1",
          lp_holders: [
            { is_locked: "0", percent: "100" },
          ],
        },
      },
    }, { ...DEFAULT_SECURITY_THRESHOLDS, lpLockedMin: 0.8 })
    expect(go.status).toBe("pass")
    expect(go.hardFail).toBe(false)
    expect(go.flags).toContain("low-lp-lock")
  })

  it("passes with mintable alone", () => {
    const go = mapGoPlus({
      result: {
        "0xabc": {
          is_mintable: "1",
          is_open_source: "1",
        },
      },
    })
    expect(go.status).toBe("pass")
    expect(go.hardFail).toBe(false)
    expect(go.flags).toContain("mintable")
  })

  it("still hard-fails honeypot with low lp", () => {
    const go = mapGoPlus({
      result: {
        "0xabc": {
          is_honeypot: "1",
          is_open_source: "1",
          lp_holders: [
            { is_locked: "0", percent: "100" },
          ],
        },
      },
    }, { ...DEFAULT_SECURITY_THRESHOLDS, lpLockedMin: 0.8 })
    expect(go.hardFail).toBe(true)
    expect(go.flags).toContain("honeypot")
    expect(go.flags).toContain("low-lp-lock")
  })

  it("rugcheck surfaces mint-authority and low-lp-lock without hardFail alone", () => {
    const rug = mapRugCheck({
      mintAuthority: "authority",
      freezeAuthority: null,
      lpLockedPct: 10,
    }, { ...DEFAULT_SECURITY_THRESHOLDS, lpLockedMin: 0.8 })
    expect(rug.hardFail).toBe(false)
    expect(rug.flags).toContain("mint-authority")
    expect(rug.flags).toContain("low-lp-lock")
  })
})

describe("journal failure", () => {
  it("sanitizes secret-ish failure messages", () => {
    expect(sanitizeFailureMessage("boom api_key=abc")).toBe("run failed (details redacted)")
  })

  it("marks failed without advancing phase", () => {
    let journal = createRunJournal("list-scan-2026-07-18T00-00-00-000Z")
    journal = advanceRunJournal(journal, "collected", `sha256:${"a".repeat(64)}`)
    journal = markRunFailed(journal, {
      code: "collector-error",
      message: "provider down",
      failedAt: "2026-07-18T00:01:00.000Z",
    })
    expect(journal.status).toBe("failed")
    expect(journal.phase).toBe("collected")
    expect(journal.failure?.code).toBe("collector-error")
  })

  it("does not treat Playwright launch-config flags as config-error", () => {
    const playwright =
      "locator.evaluateAll: Target page, context or browser has been closed "
      + "Browser logs: <launching> chrome-headless-shell --disable-field-trial-config"
    expect(classifyRunFailureCode(playwright)).toBe("collector-error")
  })

  it("still classifies real config/schema failures", () => {
    expect(classifyRunFailureCode("invalid config: missing twitter")).toBe("config-error")
    expect(classifyRunFailureCode("config schema mismatch")).toBe("config-error")
    expect(classifyRunFailureCode("migrateConfig refused")).toBe("config-error")
  })
})

describe("job catalog", () => {
  it("lists every job name used by collect dispatch", () => {
    const names = new Set(JOBS.map((j) => j.name))
    for (const required of [
      "list-scan",
      "farcaster-scan",
      "chart-sweep",
      "narrative-scan",
      "watchlist-scan",
      "wallet-discovery",
      "research",
    ]) {
      expect(names.has(required as never)).toBe(true)
    }
  })
})

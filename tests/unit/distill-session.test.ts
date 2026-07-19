import { describe, expect, it } from "vitest"
import {
  distillUserMessage,
  runDiscordDistiller,
  runTelegramOverviewDistiller,
  telegramOverviewUserMessage,
  TELEGRAM_TEXT_MAX,
  validateDiscordDistillOutput,
  validateTelegramOverviewOutput,
} from "../../src/orchestrator/distill-session.js"

const CLAIM = {
  type: "rotation" as const,
  subject: "rh-chain-meme-rotation",
  direction: "rotation" as const,
  horizonHours: 72,
  verificationRule: "rotation",
}

describe("validateDiscordDistillOutput", () => {
  it("accepts a short novel update", () => {
    const ok = validateDiscordDistillOutput(
      "RH chain meme rotation bumped to peaking. Capital rotating into RH infra.",
    )
    expect(ok).toEqual({
      ok: true,
      text: "RH chain meme rotation bumped to peaking. Capital rotating into RH infra.",
    })
  })

  it("rejects provenance handles", () => {
    expect(validateDiscordDistillOutput("Flip (twitter:@brian_armstrong)").ok).toBe(false)
    expect(validateDiscordDistillOutput("cast farcaster:@amc reacted").ok).toBe(false)
  })

  it("rejects ticker overflow", () => {
    const text = "Lane: $A vs $B vs $C vs $D"
    expect(validateDiscordDistillOutput(text)).toEqual({
      ok: false,
      reason: "ticker-overflow",
    })
  })

  it("rejects status-quo filler", () => {
    expect(validateDiscordDistillOutput("Under that you still have RH-chain rotation").ok).toBe(false)
    expect(validateDiscordDistillOutput("RH continues to dominate").ok).toBe(false)
    expect(validateDiscordDistillOutput("Sentiment remains split").ok).toBe(false)
    expect(validateDiscordDistillOutput("rh rotation still peaking").ok).toBe(false)
  })

  it("rejects unchanged-stage restatement when prior heat is known", () => {
    const unchanged = [{
      slug: "rh-chain-meme-rotation",
      title: "Robinhood chain meme rotation",
      stage: "peaking" as const,
    }]
    expect(validateDiscordDistillOutput(
      "RH chain meme rotation bumped to peaking on this scan. Fresh lanes elsewhere.",
      unchanged,
    )).toEqual({ ok: false, reason: "unchanged-stage-restatement" })
  })

  it("rejects overlong and control chars", () => {
    expect(validateDiscordDistillOutput("x".repeat(1001)).ok).toBe(false)
    expect(validateDiscordDistillOutput("bad\u0000text").ok).toBe(false)
  })
})

describe("runDiscordDistiller", () => {
  it("fails closed when disabled or missing runner", async () => {
    const disabled = await runDiscordDistiller({
      reportText: "# report",
      fallbackText: "fallback line",
      dailyCap: 10,
      usedToday: 0,
      enabled: false,
    })
    expect(disabled).toMatchObject({ text: "fallback line", usedFallback: true, reason: "disabled" })

    const noRunner = await runDiscordDistiller({
      reportText: "# report",
      fallbackText: "fallback line",
      dailyCap: 10,
      usedToday: 0,
      enabled: true,
    })
    expect(noRunner).toMatchObject({ text: "fallback line", usedFallback: true, reason: "no-runner" })
  })

  it("fails closed on cap exhaustion without launching a session", async () => {
    let launched = 0
    const result = await runDiscordDistiller({
      reportText: "# report",
      fallbackText: "fallback line",
      dailyCap: 2,
      usedToday: 2,
      enabled: true,
      runSession: async () => {
        launched += 1
        return "should not run"
      },
    })
    expect(launched).toBe(0)
    expect(result).toMatchObject({
      text: "fallback line",
      usedFallback: true,
      reason: "cap-exhausted",
      capExhausted: true,
    })
  })

  it("accepts a clean session output and increments used", async () => {
    const result = await runDiscordDistiller({
      reportText: "# report\nnew lane",
      fallbackText: "fallback line",
      auditClaim: CLAIM,
      dailyCap: 10,
      usedToday: 3,
      enabled: true,
      runSession: async ({ message }) => {
        expect(message).toContain("<untrusted-report>")
        expect(message).toContain("subject=rh-chain-meme-rotation")
        return "Dominant lane right now: Brian Armstrong Coinbase Man PFP flip"
      },
    })
    expect(result).toEqual({
      text: "Dominant lane right now: Brian Armstrong Coinbase Man PFP flip",
      usedFallback: false,
      used: 4,
      capExhausted: false,
    })
  })

  it("fails closed when session returns status-quo filler", async () => {
    const result = await runDiscordDistiller({
      reportText: "# report",
      fallbackText: "fallback line",
      dailyCap: 10,
      usedToday: 0,
      enabled: true,
      runSession: async () => "Under that you still have RH-chain rotation",
    })
    expect(result).toMatchObject({
      text: "fallback line",
      usedFallback: true,
      reason: "status-quo-filler",
      used: 1,
    })
  })

  it("fails closed on session error", async () => {
    const result = await runDiscordDistiller({
      reportText: "# report",
      fallbackText: "fallback line",
      dailyCap: 10,
      usedToday: 0,
      enabled: true,
      runSession: async () => {
        throw new Error("boom")
      },
    })
    expect(result).toMatchObject({
      text: "fallback line",
      usedFallback: true,
      reason: "session-error",
      used: 1,
    })
  })

  it("frames distill input with auditClaim and unchangedStages", () => {
    const msg = distillUserMessage({
      reportText: "body",
      auditClaim: CLAIM,
      unchangedStages: [{
        slug: "rh-chain-meme-rotation",
        title: "Robinhood chain meme rotation",
        stage: "peaking",
      }],
    })
    expect(msg).toContain("type=rotation")
    expect(msg).toContain("unchangedStages: rh-chain-meme-rotation=peaking")
    expect(msg).toContain("<untrusted-report>\nbody\n</untrusted-report>")
  })
})

describe("validateTelegramOverviewOutput", () => {
  it("accepts a landscape overview that restates peaking heat", () => {
    const text = [
      "**RH rotation**",
      "",
      "Still peaking. Fresh wallet/tibbir insider lore on the side.",
      "",
      "**Other lanes**",
      "",
      "- base trust collapse still sustained",
    ].join("\n")
    expect(validateTelegramOverviewOutput(text)).toEqual({ ok: true, text })
  })

  it("rejects provenance handles and workspace paths", () => {
    expect(validateTelegramOverviewOutput("Flip (twitter:@brian_armstrong)").ok).toBe(false)
    expect(validateTelegramOverviewOutput("see reports/list-scan-1/agent.md").ok).toBe(false)
    expect(validateTelegramOverviewOutput("inbox/foo/twitter-fyp.json").ok).toBe(false)
  })

  it("rejects overlong and control chars", () => {
    expect(validateTelegramOverviewOutput("x".repeat(TELEGRAM_TEXT_MAX + 1)).ok).toBe(false)
    expect(validateTelegramOverviewOutput("bad\u0000text").ok).toBe(false)
  })
})

describe("runTelegramOverviewDistiller", () => {
  it("fails closed when disabled or missing runner", async () => {
    const disabled = await runTelegramOverviewDistiller({
      reportText: "# Chat recall\n",
      fallbackText: "fallback line",
      dailyCap: 10,
      usedToday: 0,
      enabled: false,
    })
    expect(disabled).toMatchObject({ text: "fallback line", usedFallback: true, reason: "disabled" })

    const noRunner = await runTelegramOverviewDistiller({
      reportText: "# Chat recall\n",
      fallbackText: "fallback line",
      dailyCap: 10,
      usedToday: 0,
      enabled: true,
    })
    expect(noRunner).toMatchObject({ text: "fallback line", usedFallback: true, reason: "no-runner" })
  })

  it("accepts overview output and increments used", async () => {
    const overview =
      "RH rotation still peaking.\n\nWallet/tibbir lore is narrative ammo until verified."
    const result = await runTelegramOverviewDistiller({
      reportText: "# Chat recall\n## Host summary\n",
      fallbackText: "fallback line",
      auditClaim: CLAIM,
      knownStages: [{
        slug: "rh-chain-meme-rotation",
        title: "RH",
        stage: "peaking",
      }],
      dailyCap: 10,
      usedToday: 1,
      enabled: true,
      runSession: async ({ message }) => {
        expect(message).toContain("knownStages: rh-chain-meme-rotation=peaking")
        expect(message).toContain("<untrusted-report>")
        return overview
      },
    })
    expect(result).toEqual({
      text: overview,
      usedFallback: false,
      used: 2,
      capExhausted: false,
    })
  })

  it("fails closed when session leaks a workspace path", async () => {
    const result = await runTelegramOverviewDistiller({
      reportText: "# report",
      fallbackText: "fallback line",
      dailyCap: 10,
      usedToday: 0,
      enabled: true,
      runSession: async () => "See state/narratives/log.jsonl for more",
    })
    expect(result).toMatchObject({
      text: "fallback line",
      usedFallback: true,
      reason: "workspace-path",
      used: 1,
    })
  })

  it("frames overview input with knownStages", () => {
    const msg = telegramOverviewUserMessage({
      reportText: "body",
      auditClaim: CLAIM,
      knownStages: [{
        slug: "rh-chain-meme-rotation",
        title: "RH",
        stage: "peaking",
      }],
    })
    expect(msg).toContain("Telegram landscape overview")
    expect(msg).toContain("knownStages: rh-chain-meme-rotation=peaking")
  })
})

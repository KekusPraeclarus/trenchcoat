import { describe, expect, it } from "vitest"
import {
  DISCORD_TEXT_MAX,
  distillUserMessage,
  renderDailyDigestCompactFallback,
  resolveDistillLlmCap,
  runDiscordDistiller,
  runTelegramTopicDistiller,
  telegramTopicUserMessage,
  TELEGRAM_DIGEST_TEXT_MAX,
  TELEGRAM_TOPIC_TEXT_MAX,
  validateDiscordDistillOutput,
  validateTelegramDailyDigestOutput,
  validateTelegramTopicOutput,
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

  it("rejects bare @handles", () => {
    expect(validateDiscordDistillOutput("Flip (@brian_armstrong) live").ok).toBe(false)
    expect(validateDiscordDistillOutput("palgrani & @stockcoin_flap pushing").ok).toBe(false)
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

  it("rejects stale rotation framing for matured narratives", () => {
    const matured = [{
      slug: "rh-chain-meme-rotation",
      title: "RH Chain agent infra",
      stage: "peaking" as const,
      framing: "ecosystem" as const,
    }]
    expect(validateDiscordDistillOutput(
      "RH rotation still loud on infra catalysts this week.",
      [],
      matured,
    )).toEqual({ ok: false, reason: "stale-narrative-framing" })
  })

  it("rejects overlong and control chars", () => {
    expect(validateDiscordDistillOutput("x".repeat(DISCORD_TEXT_MAX + 1)).ok).toBe(false)
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
        expect(message).toContain("watchWindow=this week")
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

  it("fails closed on llm-budget-fraction without launching a session", async () => {
    let launched = 0
    const result = await runDiscordDistiller({
      reportText: "# report",
      fallbackText: "fallback line",
      dailyCap: 10,
      usedToday: 5,
      enabled: true,
      budgetFraction: {
        llmBudgetFraction: 0.5,
        hotDayLlmBudgetFraction: 0.25,
        hotDayMinStagedEvents: 20,
        stagedEventsThisRun: 3,
      },
      runSession: async () => {
        launched += 1
        return "should not run"
      },
    })
    expect(launched).toBe(0)
    expect(result).toMatchObject({
      text: "fallback line",
      usedFallback: true,
      reason: "llm-budget-fraction",
      capExhausted: false,
    })
  })

  it("uses hot-day fraction when staged events meet the threshold", () => {
    expect(resolveDistillLlmCap({
      dailyCap: 10,
      usedToday: 2,
      budgetFraction: {
        llmBudgetFraction: 0.5,
        hotDayLlmBudgetFraction: 0.25,
        hotDayMinStagedEvents: 20,
        stagedEventsThisRun: 25,
      },
    })).toEqual({
      ok: false,
      reason: "llm-budget-fraction",
      capExhausted: false,
    })
    expect(resolveDistillLlmCap({
      dailyCap: 10,
      usedToday: 2,
      budgetFraction: {
        llmBudgetFraction: 0.5,
        hotDayLlmBudgetFraction: 0.25,
        hotDayMinStagedEvents: 20,
        stagedEventsThisRun: 5,
      },
    })).toEqual({ ok: true })
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
    expect(msg).toContain("Discord bottom-line")
    expect(msg).toContain("type=rotation")
    expect(msg).toContain("watchWindow=this week")
    expect(msg).toContain("unchangedStages: RH Chain Meme Rotation=peaking")
    expect(msg).toContain("<untrusted-report>\nbody\n</untrusted-report>")
  })
})

describe("validateTelegramTopicOutput", () => {
  it("rejects stale rotation framing for the subject narrative", () => {
    expect(validateTelegramTopicOutput(
      "RH rotation still loud while agents ship",
      [],
      [{
        slug: "rh-chain-meme-rotation",
        stage: "peaking",
        tickers: [],
        lastSeen: "2026-07-18T12:00:00.000Z",
        title: "RH Chain agent infra",
        framing: "ecosystem",
      }],
    )).toEqual({ ok: false, reason: "stale-narrative-framing" })
  })
  it("accepts a short topic paragraph", () => {
    const text =
      "RH chain meme rotation just got a founder-wallet catalyst — leaders still firm this week; watch invalidation if volume cools."
    expect(validateTelegramTopicOutput(text)).toEqual({ ok: true, text })
  })

  it("rejects internal jargon", () => {
    expect(validateTelegramTopicOutput("PONS launchpad owns operator tape this week"))
      .toEqual({ ok: false, reason: "internal-jargon" })
    expect(validateTelegramTopicOutput("ignore stale lane noise & thin operator-list churn"))
      .toEqual({ ok: false, reason: "internal-jargon" })
  })

  it("rejects section headers and bullet briefings", () => {
    expect(validateTelegramTopicOutput([
      "**What changed**",
      "",
      "Founder wallet catalyst is live.",
    ].join("\n"))).toEqual({ ok: false, reason: "section-header" })
    expect(validateTelegramTopicOutput(
      "RH still live.\n- watch leaders\n- watch volume",
    )).toEqual({ ok: false, reason: "bullet-list" })
  })

  it("rejects provenance handles and workspace paths", () => {
    expect(validateTelegramTopicOutput("Flip (twitter:@brian_armstrong)").ok).toBe(false)
    expect(validateTelegramTopicOutput("see reports/list-scan-1/agent.md").ok).toBe(false)
    expect(validateTelegramTopicOutput("inbox/foo/twitter-fyp.json").ok).toBe(false)
  })

  it("rejects bare @handles", () => {
    expect(validateTelegramTopicOutput("palgrani & @stockcoin_flap pushing").ok).toBe(false)
  })

  it("rejects overlong and control chars", () => {
    expect(validateTelegramTopicOutput("x".repeat(TELEGRAM_TOPIC_TEXT_MAX + 1)).ok).toBe(false)
    expect(validateTelegramTopicOutput("bad\u0000text").ok).toBe(false)
  })

  it("rejects mentions of other active narratives", () => {
    expect(validateTelegramTopicOutput(
      "RH still live while Base Trust Collapse fades",
      [{ slug: "base-trust-collapse", stage: "fading", tickers: [], lastSeen: "2026-07-18T19:00:00.000Z" }],
    )).toEqual({ ok: false, reason: "cross-topic-mention" })
  })

  it("scrubs leaked hour tokens but keeps natural watch prose", () => {
    const scrubbed = validateTelegramTopicOutput("Watch over the next 72h")
    expect(scrubbed).toEqual({ ok: true, text: "Watch the next few days" })
    const natural = validateTelegramTopicOutput("Watch this month")
    expect(natural).toEqual({ ok: true, text: "Watch this month" })
  })
})

describe("validateTelegramDailyDigestOutput", () => {
  it("requires exactly the active slugs with plain bodies", () => {
    const ok = validateTelegramDailyDigestOutput(
      JSON.stringify({
        sections: [
          { slug: "rh-chain-meme-rotation", body: "Still peaking on wallet lore." },
          { slug: "base-trust-collapse", body: "Fade continues." },
        ],
      }),
      ["rh-chain-meme-rotation", "base-trust-collapse"],
    )
    expect(ok.ok).toBe(true)
  })

  it("rejects missing, unknown, duplicate, markdown, and overlong final maps", () => {
    expect(validateTelegramDailyDigestOutput(
      JSON.stringify({ sections: [{ slug: "rh-chain-meme-rotation", body: "ok" }] }),
      ["rh-chain-meme-rotation", "base-trust-collapse"],
    )).toMatchObject({ ok: false, reason: "section-count" })
    expect(validateTelegramDailyDigestOutput(
      JSON.stringify({ sections: [
        { slug: "rh-chain-meme-rotation", body: "ok" },
        { slug: "unknown", body: "ok" },
      ] }),
      ["rh-chain-meme-rotation", "base-trust-collapse"],
    )).toMatchObject({ ok: false, reason: "unknown-slug" })
    expect(validateTelegramDailyDigestOutput(
      JSON.stringify({ sections: [
        { slug: "rh-chain-meme-rotation", body: "ok" },
        { slug: "rh-chain-meme-rotation", body: "again" },
      ] }),
      ["rh-chain-meme-rotation", "base-trust-collapse"],
    )).toMatchObject({ ok: false, reason: "duplicate-slug" })
    expect(validateTelegramDailyDigestOutput(
      JSON.stringify({ sections: [{ slug: "rh-chain-meme-rotation", body: "**bold**" }] }),
      ["rh-chain-meme-rotation"],
    )).toMatchObject({ ok: false, reason: "markdown-in-body" })
  })
})

describe("runTelegramTopicDistiller", () => {
  it("fails closed when disabled or missing runner", async () => {
    const packet = {
      subject: "rh-chain-meme-rotation",
      subjectLabel: "RH Chain Meme Rotation",
      members: [{ eventId: "e1", severity: "notable", text: "fallback line" }],
      otherNarratives: [] as const,
    }
    const disabled = await runTelegramTopicDistiller({
      packet,
      fallbackText: "fallback line",
      dailyCap: 10,
      usedToday: 0,
      enabled: false,
    })
    expect(disabled).toMatchObject({ text: "fallback line", usedFallback: true, reason: "disabled" })

    const noRunner = await runTelegramTopicDistiller({
      packet,
      fallbackText: "fallback line",
      dailyCap: 10,
      usedToday: 0,
      enabled: true,
    })
    expect(noRunner).toMatchObject({ text: "fallback line", usedFallback: true, reason: "no-runner" })
  })

  it("accepts topic output and increments used", async () => {
    const overview =
      "RH rotation still peaking on wallet lore — narrative ammo until verified this week."
    const result = await runTelegramTopicDistiller({
      packet: {
        subject: "rh-chain-meme-rotation",
        subjectLabel: "RH Chain Meme Rotation",
        narrative: {
          slug: "rh-chain-meme-rotation",
          stage: "peaking",
          tickers: ["RH"],
          lastSeen: "2026-07-18T19:00:00.000Z",
        },
        members: [{
          eventId: "e1",
          severity: "notable",
          text: "body",
          auditClaim: CLAIM,
        }],
        otherNarratives: [{
          slug: "base-trust-collapse",
          stage: "fading",
          tickers: [],
          lastSeen: "2026-07-18T18:00:00.000Z",
        }],
      },
      fallbackText: "fallback line",
      dailyCap: 10,
      usedToday: 1,
      enabled: true,
      runSession: async ({ message }) => {
        expect(message).toContain("subjectLabel=RH Chain Meme Rotation")
        expect(message).toContain("otherNarratives (forbidden)")
        expect(message).toContain("base-trust-collapse")
        expect(message).toContain("<untrusted-topic-packet>")
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
    const result = await runTelegramTopicDistiller({
      packet: {
        subject: "rh-chain-meme-rotation",
        subjectLabel: "RH Chain Meme Rotation",
        members: [{ eventId: "e1", severity: "notable", text: "fallback line" }],
        otherNarratives: [],
      },
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

  it("frames topic input without a global chat report", () => {
    const msg = telegramTopicUserMessage({
      subject: "rh-chain-meme-rotation",
      subjectLabel: "RH Chain Meme Rotation",
      members: [{
        eventId: "legacy",
        severity: "notable",
        text: "body",
        auditClaim: CLAIM,
      }],
      otherNarratives: [],
    })
    expect(msg).toContain("Telegram topic update")
    expect(msg).toContain("watchWindow=this week")
    expect(msg).toContain("<untrusted-topic-packet>")
    expect(msg).not.toContain("Chat recall")
  })

  it("annotates mature framing on topic and discord distill packets", () => {
    const msg = telegramTopicUserMessage({
      subject: "rh-chain-meme-rotation",
      subjectLabel: "RH Chain agent infra",
      narrative: {
        slug: "rh-chain-meme-rotation",
        stage: "peaking",
        tickers: [],
        lastSeen: "2026-07-18T12:00:00.000Z",
        title: "RH Chain agent infra",
        framing: "ecosystem",
      },
      members: [{
        eventId: "e1",
        severity: "notable",
        text: "infra catalyst",
        auditClaim: CLAIM,
      }],
      otherNarratives: [],
    })
    expect(msg).toContain("framing=ecosystem")
    expect(msg).toContain("subjectLabel=RH Chain agent infra")

    const discord = distillUserMessage({
      reportText: "report",
      unchangedStages: [{
        slug: "rh-chain-meme-rotation",
        title: "RH Chain agent infra",
        stage: "peaking",
        framing: "ecosystem",
      }],
    })
    expect(discord).toContain("framing=ecosystem")
    expect(discord).toContain("RH Chain agent infra=peaking")
  })
})

describe("daily digest rendering", () => {
  it("keeps compact fallback within the Telegram cap", () => {
    const narratives = Array.from({ length: 12 }, (_, index) => ({
      slug: `lane-${index}`,
      stage: (index % 3 === 0 ? "peaking" : index % 3 === 1 ? "emerging" : "fading") as
        "peaking" | "emerging" | "fading",
      tickers: [],
      lastSeen: `2026-07-18T${String(10 + index).padStart(2, "0")}:00:00.000Z`,
    }))
    const rendered = renderDailyDigestCompactFallback({
      londonDate: "2026-07-18",
      narratives,
      developmentsBySlug: Object.fromEntries(
        narratives.map((entry) => [entry.slug, "Host-approved topic summary for the window."]),
      ),
    })
    expect(rendered).not.toBeNull()
    expect([...(rendered ?? "")].length).toBeLessThanOrEqual(TELEGRAM_DIGEST_TEXT_MAX)
    for (const entry of narratives) {
      expect(rendered).toContain(entry.slug.replace("lane-", "Lane "))
    }
  })

  it("omits quiet narratives and never invents a no-development filler", () => {
    const rendered = renderDailyDigestCompactFallback({
      londonDate: "2026-07-18",
      narratives: [{
        slug: "rh-chain-meme-rotation",
        stage: "peaking",
        tickers: ["RH"],
        lastSeen: "2026-07-18T12:00:00.000Z",
      }, {
        slug: "base-trust-collapse",
        stage: "fading",
        tickers: [],
        lastSeen: "2026-07-17T12:00:00.000Z",
      }],
      developmentsBySlug: {
        "rh-chain-meme-rotation": "Wallet lore catalyst printed.",
        "base-trust-collapse": "",
      },
    })
    expect(rendered).toContain("RH Chain Meme Rotation")
    expect(rendered).toContain("Wallet lore catalyst printed.")
    expect(rendered).not.toContain("Base Trust Collapse")
    expect(rendered).not.toContain("No host-approved development")
  })

  it("uses preferred mature titles in digest headers", () => {
    const rendered = renderDailyDigestCompactFallback({
      londonDate: "2026-07-18",
      narratives: [{
        slug: "rh-chain-meme-rotation",
        stage: "peaking",
        tickers: [],
        lastSeen: "2026-07-18T12:00:00.000Z",
        title: "RH Chain agent infra",
        framing: "ecosystem",
      }],
      developmentsBySlug: {
        "rh-chain-meme-rotation": "Protocol agents shipping.",
      },
    })
    expect(rendered).toContain("RH Chain agent infra")
    expect(rendered).not.toContain("RH Chain Meme Rotation")
  })

  it("returns null when there are no window developments", () => {
    expect(renderDailyDigestCompactFallback({
      londonDate: "2026-07-18",
      narratives: [{
        slug: "base-trust-collapse",
        stage: "fading",
        tickers: [],
        lastSeen: "2026-07-17T12:00:00.000Z",
      }],
      developmentsBySlug: { "base-trust-collapse": "" },
    })).toBeNull()
  })

  it("returns null when mandatory headers alone exceed the cap", () => {
    const narratives = Array.from({ length: 80 }, (_, index) => ({
      slug: `very-long-narrative-label-number-${index}`,
      stage: "peaking" as const,
      tickers: [],
      lastSeen: "2026-07-18T19:00:00.000Z",
    }))
    expect(renderDailyDigestCompactFallback({
      londonDate: "2026-07-18",
      narratives,
      developmentsBySlug: Object.fromEntries(
        narratives.map((entry) => [entry.slug, "moved"]),
      ),
    })).toBeNull()
  })
})

/**
 * Watch update writer — host-side, fail-closed LLM narration for material monitor
 * diffs. Uses composer-2.5 (not fast); research replies stay on chat.discord.model.
 */

import { hasLocalWorkspaceRefs } from "../lib/telegram-format.js"
import { WATCH_UPDATE_PROMPT } from "../prompts/host.js"
import { runOneShotSession } from "../orchestrator/session.js"
import type { MaterialChange } from "./materiality.js"
import { formatMaterialChangeGloss, renderWatchUpdateFactsOnly } from "./materiality.js"

export const WATCH_UPDATE_MODEL = "composer-2.5"
export const WATCH_UPDATE_TEXT_MAX = 1200
export const WATCH_UPDATE_TIMEOUT_MS = 60_000

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u
const PROVENANCE_HANDLE = /(?:twitter|farcaster):@[\w.-]+/iu

export type WatchUpdateSessionRunner = (
  args: Readonly<{ prompt: string; message: string }>,
) => Promise<string>

export type WatchUpdateArgs = Readonly<{
  chain: string
  tokenAddress: string
  symbolDisplay?: string
  observedAt: string
  changes: readonly MaterialChange[]
  researchBrief?: string
  agentRoot: string
  runSession?: WatchUpdateSessionRunner
}>

export type WatchUpdateResult = Readonly<{
  text: string
  usedFallback: boolean
  reason?: string
}>

function stripFence(raw: string): string {
  let text = raw.trim()
  if (text.startsWith("```") && text.endsWith("```")) {
    text = text.replace(/^```(?:\w+)?\n?/u, "").replace(/\n?```$/u, "").trim()
  }
  return text
}

function normalizeWatchUpdateText(text: string): string {
  return text.replace(/\u2014/g, "-").replace(/\u2013/g, "-")
}

function tokenLabel(args: WatchUpdateArgs): string {
  return args.symbolDisplay
    ? `${args.symbolDisplay} (${args.chain}:${args.tokenAddress})`
    : `${args.chain}:${args.tokenAddress}`
}

export function watchUpdateUserMessage(args: WatchUpdateArgs): string {
  const brief = (args.researchBrief ?? "").trim()
  const changeLines = args.changes.map((c) => formatMaterialChangeGloss(c))
  return [
    "Write a Discord watch update using the system rules.",
    `token: ${tokenLabel(args)}`,
    "<metric-changes>",
    ...changeLines,
    "</metric-changes>",
    brief.length > 0 ? "<research-brief>" : "<research-brief empty>",
    brief.length > 0 ? brief : "(no brief stored from initial research)",
    "</research-brief>",
  ].join("\n")
}

export function validateWatchUpdateOutput(
  raw: string,
): { ok: true; text: string } | { ok: false; reason: string } {
  const text = normalizeWatchUpdateText(stripFence(raw))
  if (text.length < 1) return { ok: false, reason: "empty" }
  if ([...text].length > WATCH_UPDATE_TEXT_MAX) return { ok: false, reason: "too-long" }
  if (CONTROL_CHARS.test(text)) return { ok: false, reason: "control-chars" }
  if (PROVENANCE_HANDLE.test(text)) return { ok: false, reason: "provenance-handle" }
  if (hasLocalWorkspaceRefs(text)) return { ok: false, reason: "workspace-path" }
  return { ok: true, text }
}

function factsFallback(args: WatchUpdateArgs): string {
  return renderWatchUpdateFactsOnly({
    chain: args.chain,
    tokenAddress: args.tokenAddress,
    ...(args.symbolDisplay ? { symbolDisplay: args.symbolDisplay } : {}),
    observedAt: args.observedAt,
    changes: args.changes,
  })
}

export async function runWatchUpdateWriter(args: WatchUpdateArgs): Promise<WatchUpdateResult> {
  const fallback = (reason: string): WatchUpdateResult => ({
    text: factsFallback(args),
    usedFallback: true,
    reason,
  })

  const runSession = args.runSession ?? (async (sessionArgs) => {
    const session = await runOneShotSession({
      prompt: `${sessionArgs.prompt}\n\n${sessionArgs.message}`,
      cwd: args.agentRoot,
      model: WATCH_UPDATE_MODEL,
      mode: "ask",
      sandbox: true,
      timeoutMs: WATCH_UPDATE_TIMEOUT_MS,
    })
    if (session.status !== "finished" || !session.text) {
      throw new Error(session.error ?? "watch update session failed")
    }
    return session.text
  })

  const tryWrite = async (): Promise<{ ok: true; text: string } | { ok: false; reason: string }> => {
    try {
      const raw = await runSession({
        prompt: WATCH_UPDATE_PROMPT,
        message: watchUpdateUserMessage(args),
      })
      const checked = validateWatchUpdateOutput(raw)
      if (!checked.ok) return { ok: false, reason: checked.reason }
      return { ok: true, text: checked.text }
    } catch {
      return { ok: false, reason: "session-error" }
    }
  }

  const first = await tryWrite()
  if (first.ok) return { text: first.text, usedFallback: false }

  const second = await tryWrite()
  if (second.ok) return { text: second.text, usedFallback: false }

  return fallback(second.reason)
}

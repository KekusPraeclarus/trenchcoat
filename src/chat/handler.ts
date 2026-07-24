import { log } from "../lib/log.js"
import {
  CHAT_DIRECTIVE_HELP,
  parseChatDirectives,
} from "./directives.js"
import type { ChatTurnOptions, ChatTurnRunner } from "./session.js"
import {
  extractResearchIntent,
  isCancelText,
  isConfirmText,
  researchConfirmPrompt,
} from "./research-intent.js"
import {
  cancelPending,
  clearExpiredPending,
  confirmPending,
  isResearchChoiceText,
  proposeResearch,
  selectResearchChoice,
  type PendingResearchStore,
} from "./pending-research.js"
import { prepareTelegramReply } from "./telegram-reply.js"

export function isChatAllowed(userId: string, allowlist: readonly string[]): boolean {
  return allowlist.includes(userId)
}

export type ChatSender = (chatId: string, text: string) => Promise<void>

export type ChatDraftStream = Readonly<{
  begin(): Promise<void>
  update(text: string): Promise<void>
  flush(): Promise<void>
}>

export type ResearchConfirmHooks = Readonly<{
  store: PendingResearchStore
  ttlMinutes: number
  nowIso?: () => string
  /** Fired after a durable confirm so the host can pump research async */
  onConfirmed?: (requestId: string) => void
}>

/**
 * Operator-only exoneration commands (`undock <id>` / `confirm <id>`). Injected so the
 * handler stays free of archive/state wiring; the caller binds these to the operator's
 * SourceWriter and archive. Each returns a short reply line to DM back.
 */
export type ExonerationCommandHooks = Readonly<{
  undock: (id: string) => Promise<string>
  confirm: (id: string) => Promise<string>
}>

export type RemediationCommandHooks = Readonly<{
  handle: (text: string, operatorId: string) => Promise<string | null>
}>

export async function handleChatUpdate(args: Readonly<{
  chatId: string
  userId: string
  text: string
  allowlist: readonly string[]
  /** When set, replies always go here (operator DM) — never a group chatId (INV-B3) */
  replyChatId?: string
  send: ChatSender
  /** Native Telegram draft preview while the agent generates */
  openDraft?: () => ChatDraftStream
  runTurn?: ChatTurnRunner
  research?: ResearchConfirmHooks
  exoneration?: ExonerationCommandHooks
  remediation?: RemediationCommandHooks
  /** When set, overlong replies persist under reports/chat/ */
  agentRoot?: string
  /** Host homes for `/status` health snapshot (same builder as `tc status`) */
  statusHomes?: Readonly<{ agentRoot: string, archiveRoot: string }>
}>): Promise<"ignored" | "replied"> {
  if (!isChatAllowed(args.userId, args.allowlist)) {
    return "ignored"
  }

  const target = args.replyChatId ?? args.chatId
  const trimmed = args.text.trim()
  const nowIso = args.research?.nowIso ?? (() => new Date().toISOString())

  if (trimmed === "/status" || trimmed.startsWith("/status ")) {
    if (args.statusHomes) {
      const { buildHealthSnapshot, formatHealthText } = await import("../orchestrator/health.js")
      const health = await buildHealthSnapshot({
        agentRoot: args.statusHomes.agentRoot,
        archiveRoot: args.statusHomes.archiveRoot,
        nowIso: nowIso(),
      })
      await args.send(target, formatHealthText(health))
    } else {
      await args.send(target, "trenchcoat online")
    }
    return "replied"
  }

  if (trimmed === "/start" || trimmed.startsWith("/start ")) {
    await args.send(
      target,
      [
        "trenchcoat chat online. Ask about the knowledge store — watchlist, narratives, sources, wallets, recent reports. Ask to research a token and confirm to launch a host research run.",
        "",
        CHAT_DIRECTIVE_HELP,
      ].join("\n"),
    )
    return "replied"
  }

  // Operator exoneration commands take precedence over research parsing so `confirm ex-123`
  // resolves a docked source rather than being read as a research confirmation.
  if (args.exoneration) {
    const undockMatch = /^undock\s+(\S+)/iu.exec(trimmed)
    const confirmMatch = /^confirm\s+(\S+)/iu.exec(trimmed)
    const id = (undockMatch ?? confirmMatch)?.[1]
    if (id) {
      try {
        const reply = undockMatch
          ? await args.exoneration.undock(id)
          : await args.exoneration.confirm(id)
        await args.send(target, reply)
      } catch (error) {
        await args.send(
          target,
          `exoneration failed: ${error instanceof Error ? error.message : "unknown"}`,
        )
      }
      return "replied"
    }
  }

  // Remediation approval/status before general chat so exact commands never reach the model.
  if (args.remediation) {
    try {
      const reply = await args.remediation.handle(trimmed, args.userId)
      if (reply !== null) {
        await args.send(target, reply)
        return "replied"
      }
    } catch (error) {
      await args.send(
        target,
        `remediation failed: ${error instanceof Error ? error.message : "unknown"}`,
      )
      return "replied"
    }
  }

  // Strip leading model/mode directives before research intent and the LLM prompt.
  const directives = parseChatDirectives(trimmed)
  if (directives.directiveOnly) {
    await args.send(target, CHAT_DIRECTIVE_HELP)
    return "replied"
  }
  const body = directives.body
  const turnOpts: ChatTurnOptions | undefined = directives.hasOverride
    ? {
      ...(directives.model ? { model: directives.model } : {}),
      ...(directives.mode ? { mode: directives.mode } : {}),
    }
    : undefined

  if (args.research) {
    let file = clearExpiredPending(args.research.store.load(), nowIso())
    if (!file.telegramUserId) {
      file = { ...file, telegramUserId: args.userId }
    } else if (file.telegramUserId !== args.userId) {
      // Bound store to allowlisted operator; never act on foreign pending state
      file = {
        schema: 1,
        telegramUserId: args.userId,
        pending: null,
        pendingChoice: null,
        confirmed: [],
      }
      args.research.store.save(file)
    }

    if (isCancelText(body)) {
      const hadPending = Boolean(file.pending || file.pendingChoice)
      const choiceId = file.pendingChoice?.requestId
      const next = cancelPending(file, args.userId)
      if (hadPending) {
        args.research.store.save(
          choiceId
            ? {
              ...next,
              confirmed: next.confirmed.filter((entry) => entry.requestId !== choiceId),
            }
            : next,
        )
      }
      await args.send(
        target,
        hadPending ? "cancelled pending research" : "nothing pending to cancel",
      )
      return "replied"
    }

    if (file.pendingChoice && isResearchChoiceText(body)) {
      const result = selectResearchChoice({
        file,
        telegramUserId: args.userId,
        nowIso: nowIso(),
        selection: body,
      })
      if (result.error || !result.confirmed) {
        await args.send(target, result.error ?? "invalid pick")
        return "replied"
      }
      args.research.store.save(result.file)
      await args.send(
        target,
        `selected ${result.confirmed.subject} — queuing research (${result.confirmed.requestId})`,
      )
      args.research.onConfirmed?.(result.confirmed.requestId)
      return "replied"
    }

    if (isConfirmText(body)) {
      const result = confirmPending({
        file,
        telegramUserId: args.userId,
        nowIso: nowIso(),
      })
      if (result.error || !result.confirmed) {
        await args.send(target, result.error ?? "nothing to confirm")
        return "replied"
      }
      args.research.store.save(result.file)
      await args.send(
        target,
        `confirmed — queuing research for ${result.confirmed.subject} (${result.confirmed.requestId})`,
      )
      args.research.onConfirmed?.(result.confirmed.requestId)
      return "replied"
    }

    // Research confirm stays on the host path — ignore model/mode directives here.
    const intent = extractResearchIntent(body)
    if (intent.kind === "research" && intent.subject) {
      const proposed = proposeResearch({
        file,
        telegramUserId: args.userId,
        intent,
        nowIso: nowIso(),
        ttlMinutes: args.research.ttlMinutes,
      })
      args.research.store.save(proposed.file)
      await args.send(target, researchConfirmPrompt(intent))
      return "replied"
    }
  }

  if (!args.runTurn) {
    await args.send(target, "chat agent not wired")
    return "replied"
  }

  const draft = args.openDraft?.()
  try {
    if (draft) await draft.begin()
    const reply = draft
      ? await args.runTurn(body, {
        onPartial: async (text) => {
          await draft.update(text)
        },
      }, turnOpts)
      : await args.runTurn(body, undefined, turnOpts)
    if (draft) await draft.flush()
    const prepared = await prepareTelegramReply({
      text: reply,
      ...(args.agentRoot ? { agentRoot: args.agentRoot } : {}),
    })
    for (const part of prepared.parts) {
      await args.send(target, part)
    }
    // Host may act on a bounded approve|defer|reject intent forwarded by the operator agent.
    if (args.remediation) {
      const { parseForwardedRemediationIntent } = await import("../remediation/approval.js")
      const intent = parseForwardedRemediationIntent(reply)
      if (intent) {
        const cmd = `${intent.action} remediation ${intent.incidentId}`
        const follow = await args.remediation.handle(cmd, args.userId)
        if (follow) await args.send(target, follow)
      }
    }
  } catch (error) {
    if (draft) await draft.flush().catch(() => undefined)
    const detail = error instanceof Error ? error.message : "unknown"
    log.error("chat turn failed", { detail })
    const hint = detail.includes("timed out")
      ? "chat turn timed out — try again or ask something smaller"
      : detail.includes("TRENCHCOAT_REPO_ROOT") || detail.includes("repo root")
        ? `chat turn failed — ${detail}`
        : "chat turn failed — check listener logs"
    await args.send(target, hint)
  }
  return "replied"
}

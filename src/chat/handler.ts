import type { ChatTurnRunner } from "./session.js"
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
  /** When set, overlong replies persist under reports/chat/ */
  agentRoot?: string
}>): Promise<"ignored" | "replied"> {
  if (!isChatAllowed(args.userId, args.allowlist)) {
    return "ignored"
  }

  const target = args.replyChatId ?? args.chatId
  const trimmed = args.text.trim()
  const nowIso = args.research?.nowIso ?? (() => new Date().toISOString())

  if (trimmed === "/status" || trimmed.startsWith("/status ")) {
    await args.send(target, "trenchcoat online")
    return "replied"
  }

  if (trimmed === "/start" || trimmed.startsWith("/start ")) {
    await args.send(
      target,
      "trenchcoat chat online. Ask about the knowledge store — watchlist, narratives, sources, wallets, recent reports. Ask to research a token and confirm to launch a host research run.",
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

    if (isCancelText(trimmed)) {
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

    if (file.pendingChoice && isResearchChoiceText(trimmed)) {
      const result = selectResearchChoice({
        file,
        telegramUserId: args.userId,
        nowIso: nowIso(),
        selection: trimmed,
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

    if (isConfirmText(trimmed)) {
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

    const intent = extractResearchIntent(trimmed)
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
      ? await args.runTurn(trimmed, {
        onPartial: async (text) => {
          await draft.update(text)
        },
      })
      : await args.runTurn(trimmed)
    if (draft) await draft.flush()
    const prepared = await prepareTelegramReply({
      text: reply,
      ...(args.agentRoot ? { agentRoot: args.agentRoot } : {}),
    })
    for (const part of prepared.parts) {
      await args.send(target, part)
    }
  } catch (error) {
    if (draft) await draft.flush().catch(() => undefined)
    const detail = error instanceof Error ? error.message : "unknown"
    const hint = detail.includes("timed out")
      ? "chat turn timed out — try again or ask something smaller"
      : "chat turn failed — check listener logs"
    await args.send(target, hint)
  }
  return "replied"
}

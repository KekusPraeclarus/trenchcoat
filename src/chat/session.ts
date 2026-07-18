import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { log } from "../lib/log.js"
import {
  createCursorChat,
  runStreamingSession,
  type SessionResult,
} from "../orchestrator/session.js"
import {
  assertAgentIntegrity,
  captureIntegritySnapshot,
} from "../orchestrator/integrity.js"
import { buildChatPrompt } from "./prompt.js"

export type ChatSessionState = Readonly<{
  cursorChatId: string
  lastActivityAt: string
  telegramUserId: string
}>

export type ChatSessionStore = Readonly<{
  load(): ChatSessionState | undefined
  save(state: ChatSessionState): void
  clear(): void
}>

export function fileChatSessionStore(path: string): ChatSessionStore {
  return {
    load() {
      if (!existsSync(path)) return undefined
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ChatSessionState>
        if (
          typeof raw.cursorChatId !== "string"
          || typeof raw.lastActivityAt !== "string"
          || typeof raw.telegramUserId !== "string"
        ) {
          return undefined
        }
        return {
          cursorChatId: raw.cursorChatId,
          lastActivityAt: raw.lastActivityAt,
          telegramUserId: raw.telegramUserId,
        }
      } catch {
        return undefined
      }
    },
    save(state) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    },
    clear() {
      if (!existsSync(path)) return
      writeFileSync(path, "{}\n", { mode: 0o600 })
    },
  }
}

export function sessionExpired(
  state: ChatSessionState,
  idleTimeoutMinutes: number,
  nowMs = Date.now(),
): boolean {
  const last = Date.parse(state.lastActivityAt)
  if (!Number.isFinite(last)) return true
  return nowMs - last >= idleTimeoutMinutes * 60_000
}

export type ChatStreamSink = Readonly<{
  onPartial?: (text: string) => void | Promise<void>
}>

export type ChatTurnRunner = (
  operatorText: string,
  sink?: ChatStreamSink,
) => Promise<string>

export function createChatTurnRunner(opts: Readonly<{
  agentRoot: string
  telegramUserId: string
  idleTimeoutMinutes: number
  store: ChatSessionStore
  createChat?: () => Promise<string>
  runSession?: (args: Readonly<{
    prompt: string
    cwd: string
    resumeChatId: string
    onPartial?: (text: string) => void | Promise<void>
  }>) => Promise<SessionResult>
  nowIso?: () => string
  timeoutMs?: number
}>): ChatTurnRunner {
  const createChat = opts.createChat ?? (() => createCursorChat())
  const runSession = opts.runSession ?? ((args) => runStreamingSession({
    prompt: args.prompt,
    cwd: args.cwd,
    resumeChatId: args.resumeChatId,
    mode: "ask",
    sandbox: true,
    // Overnight / cold Cursor CLI starts often exceed 3m; keep below job default (15m)
    timeoutMs: opts.timeoutMs ?? 10 * 60_000,
    ...(args.onPartial ? { onPartial: args.onPartial } : {}),
  }))
  const nowIso = opts.nowIso ?? (() => new Date().toISOString())

  return async (operatorText, sink) => {
    let state = opts.store.load()
    const now = nowIso()
    if (
      !state
      || state.telegramUserId !== opts.telegramUserId
      || sessionExpired(state, opts.idleTimeoutMinutes, Date.parse(now))
    ) {
      const cursorChatId = await createChat()
      state = {
        cursorChatId,
        lastActivityAt: now,
        telegramUserId: opts.telegramUserId,
      }
      opts.store.save(state)
      log.info("chat session created", { cursorChatId })
    }

    const prompt = buildChatPrompt(operatorText)
    log.info("chat turn start", { cursorChatId: state.cursorChatId, streaming: true })
    const integrityBefore = captureIntegritySnapshot(opts.agentRoot)
    const result = await runSession({
      prompt,
      cwd: opts.agentRoot,
      resumeChatId: state.cursorChatId,
      ...(sink?.onPartial ? { onPartial: sink.onPartial } : {}),
    })
    assertAgentIntegrity(opts.agentRoot, integrityBefore)

    opts.store.save({
      ...state,
      lastActivityAt: nowIso(),
    })

    if (result.status === "error") {
      log.error("chat turn failed", { detail: result.error ?? "unknown" })
      throw new Error(result.error ?? "chat session failed")
    }
    const text = result.text?.trim()
    if (!text) throw new Error("chat session returned empty reply")
    return text
  }
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { log } from "../lib/log.js"
import {
  createCursorChat,
  runStreamingSession,
  type SessionMode,
  type SessionResult,
} from "../orchestrator/session.js"
import {
  assertInstructionIntegrity,
  captureInstructionIntegritySnapshot,
} from "../orchestrator/integrity.js"
import {
  CHAT_DEFAULT_MODEL,
  type ChatExecutionMode,
} from "./directives.js"
import { buildChatPrompt, buildCodeChatPrompt } from "./prompt.js"
import { resolveChatRepoRoot } from "./repo-root.js"

export type ChatSessionState = Readonly<{
  cursorChatId: string
  lastActivityAt: string
  telegramUserId: string
  turnCount: number
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
          turnCount: typeof raw.turnCount === "number" && Number.isFinite(raw.turnCount)
            ? Math.max(0, Math.floor(raw.turnCount))
            : 0,
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

export function turnCountExpired(
  state: ChatSessionState,
  turnCountMax: number,
): boolean {
  return state.turnCount >= turnCountMax
}

export function estimatePromptChars(prompt: string): number {
  return prompt.length
}

export type ChatStreamSink = Readonly<{
  onPartial?: (text: string) => void | Promise<void>
}>

/** Per-message overrides from leading Telegram directives (stripped before body) */
export type ChatTurnOptions = Readonly<{
  model?: string
  mode?: ChatExecutionMode
}>

export type ChatTurnRunner = (
  operatorText: string,
  sink?: ChatStreamSink,
  turn?: ChatTurnOptions,
) => Promise<string>

export type ChatSessionLaunch = Readonly<{
  prompt: string
  cwd: string
  model: string
  sandbox: boolean
  force: boolean
  /** Cursor --mode; omit for tool-enabled /agent */
  mode?: SessionMode
  resumeChatId?: string
  onPartial?: (text: string) => void | Promise<void>
}>

/** Pure launch policy for tests and the default runner */
export function resolveChatSessionLaunch(args: Readonly<{
  operatorText: string
  agentRoot: string
  turn?: ChatTurnOptions
  resumeChatId?: string
  resolveRepoRoot?: () => string
}>): ChatSessionLaunch {
  const mode = args.turn?.mode
  const model = args.turn?.model ?? CHAT_DEFAULT_MODEL
  const codeRoot = mode === "plan" || mode === "agent"
  if (codeRoot) {
    const resolveRoot = args.resolveRepoRoot ?? (() => resolveChatRepoRoot())
    const cwd = resolveRoot()
    return {
      prompt: buildCodeChatPrompt(args.operatorText),
      cwd,
      model,
      sandbox: mode !== "agent",
      force: mode === "agent",
      ...(mode === "plan" ? { mode: "plan" as const } : {}),
      // one-off: never resume durable ask chat into plan/agent
    }
  }

  // Model-only override: still ask + agent workspace, but one-off (no resume)
  const oneOff = Boolean(args.turn?.model)
  return {
    prompt: buildChatPrompt(args.operatorText),
    cwd: args.agentRoot,
    model,
    sandbox: true,
    force: false,
    mode: "ask",
    ...(!oneOff && args.resumeChatId ? { resumeChatId: args.resumeChatId } : {}),
  }
}

export function createChatTurnRunner(opts: Readonly<{
  agentRoot: string
  telegramUserId: string
  idleTimeoutMinutes: number
  turnCountMax: number
  maxPromptChars: number
  store: ChatSessionStore
  createChat?: () => Promise<string>
  runSession?: (args: ChatSessionLaunch) => Promise<SessionResult>
  resolveRepoRoot?: () => string
  nowIso?: () => string
  timeoutMs?: number
}>): ChatTurnRunner {
  const createChat = opts.createChat ?? (() => createCursorChat())
  const runSession = opts.runSession ?? ((args) => runStreamingSession({
    prompt: args.prompt,
    cwd: args.cwd,
    model: args.model,
    sandbox: args.sandbox,
    ...(args.force ? { force: true } : {}),
    ...(args.mode ? { mode: args.mode } : {}),
    ...(args.resumeChatId ? { resumeChatId: args.resumeChatId } : {}),
    // Overnight / cold Cursor CLI starts often exceed 3m; keep below job default (15m)
    timeoutMs: opts.timeoutMs ?? 10 * 60_000,
    ...(args.onPartial ? { onPartial: args.onPartial } : {}),
  }))
  const nowIso = opts.nowIso ?? (() => new Date().toISOString())

  return async (operatorText, sink, turn) => {
    const now = nowIso()
    const codeRoot = turn?.mode === "plan" || turn?.mode === "agent"
    const oneOff = Boolean(turn?.model || codeRoot)

    // Durable ask-chat lifecycle only when staying on the default path
    let resumeChatId: string | undefined
    let state = opts.store.load()
    if (!oneOff) {
      const promptPreview = buildChatPrompt(operatorText)
      const needsNewChat = !state
        || state.telegramUserId !== opts.telegramUserId
        || sessionExpired(state, opts.idleTimeoutMinutes, Date.parse(now))
        || turnCountExpired(state, opts.turnCountMax)
        || estimatePromptChars(promptPreview) > opts.maxPromptChars
      if (needsNewChat) {
        const priorId = state?.telegramUserId === opts.telegramUserId
          ? state.cursorChatId
          : undefined
        try {
          const cursorChatId = await createChat()
          state = {
            cursorChatId,
            lastActivityAt: now,
            telegramUserId: opts.telegramUserId,
            turnCount: 0,
          }
          opts.store.save(state)
          log.info("chat session created", { cursorChatId })
        } catch (error) {
          // Idle rotation is our hygiene policy, not a Cursor invalidation. Under
          // load (post-deploy, concurrent Discord research) create-chat can time
          // out — resume the prior id rather than failing the operator turn.
          if (!priorId) throw error
          const detail = error instanceof Error ? error.message : "unknown"
          log.warn("chat create-chat failed; resuming prior session", { detail, priorId })
          state = {
            cursorChatId: priorId,
            lastActivityAt: now,
            telegramUserId: opts.telegramUserId,
            turnCount: state?.turnCount ?? 0,
          }
          opts.store.save(state)
        }
      }
      if (!state) {
        throw new Error("chat session missing after create")
      }
      resumeChatId = state.cursorChatId
    }

    const launch = resolveChatSessionLaunch({
      operatorText,
      agentRoot: opts.agentRoot,
      ...(turn ? { turn } : {}),
      ...(resumeChatId ? { resumeChatId } : {}),
      ...(opts.resolveRepoRoot ? { resolveRepoRoot: opts.resolveRepoRoot } : {}),
    })

    log.info("chat turn start", {
      cursorChatId: resumeChatId ?? "one-off",
      streaming: true,
      model: launch.model,
      mode: launch.mode ?? "agent",
      sandbox: launch.sandbox,
      cwd: launch.cwd,
    })
    const integrityBefore = captureInstructionIntegritySnapshot(opts.agentRoot)
    const result = await runSession({
      ...launch,
      ...(sink?.onPartial ? { onPartial: sink.onPartial } : {}),
    })
    try {
      assertInstructionIntegrity(opts.agentRoot, integrityBefore)
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown"
      log.error("chat turn failed", { detail })
      throw error
    }

    if (result.status === "error") {
      log.error("chat turn failed", { detail: result.error ?? "unknown" })
      if (!oneOff && state) {
        // Do not increment turnCount on failed turns
        opts.store.save({
          ...state,
          lastActivityAt: nowIso(),
        })
      }
      throw new Error(result.error ?? "chat session failed")
    }
    const text = result.text?.trim()
    if (!text) {
      log.error("chat turn failed", { detail: "chat session returned empty reply" })
      if (!oneOff && state) {
        opts.store.save({
          ...state,
          lastActivityAt: nowIso(),
        })
      }
      throw new Error("chat session returned empty reply")
    }

    if (!oneOff && state) {
      opts.store.save({
        ...state,
        lastActivityAt: nowIso(),
        turnCount: state.turnCount + 1,
      })
    }
    return text
  }
}

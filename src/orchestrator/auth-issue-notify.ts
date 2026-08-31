import { join } from "node:path"
import { homedir } from "node:os"
import { log } from "../lib/log.js"
import { telegramSendOperatorMessageChunks } from "../lib/telegram-bot.js"
import { systemClock } from "../lib/clock.js"
import {
  authIssuesPath,
  authKindFromFailureCode,
  clearAuthIssue,
  isSessionAuthFailureCode,
  loadAuthIssueFile,
  markAuthIssuesAlerted,
  recordAuthIssue,
  renderAuthIssueOperatorNotice,
  shouldAlertAuthIssues,
  type AuthIssueKind,
  type AuthIssueSource,
} from "../lib/auth-issues.js"

export type AuthIssueSend = (text: string) => Promise<void>

async function defaultOperatorSend(text: string): Promise<void> {
  const token = process.env["TELEGRAM_BOT_TOKEN"]
  const operatorId = process.env["TELEGRAM_OPERATOR_ID"]
  if (!token || !operatorId) {
    log.warn("auth-issue notify skipped — operator telegram env missing")
    return
  }
  await telegramSendOperatorMessageChunks(fetch, token, operatorId, text)
}

export async function notifyConcurrentAuthIssues(args: Readonly<{
  home?: string
  send?: AuthIssueSend
  nowIso?: string
}> = {}): Promise<"sent" | "skipped"> {
  const path = authIssuesPath(args.home ?? join(homedir(), ".trenchcoat"))
  const file = loadAuthIssueFile(path)
  if (!shouldAlertAuthIssues(file)) return "skipped"
  const text = renderAuthIssueOperatorNotice(file)
  const send = args.send ?? defaultOperatorSend
  try {
    await send(text)
  } catch (error) {
    log.warn("auth-issue notify failed", {
      detail: error instanceof Error ? error.message : String(error),
    })
    return "skipped"
  }
  await markAuthIssuesAlerted({
    path,
    file,
    sentAt: args.nowIso ?? systemClock.nowIso(),
  })
  return "sent"
}

export async function reportSessionAuthIssue(args: Readonly<{
  source: AuthIssueSource
  kind: AuthIssueKind
  at: string
  detail?: string
  home?: string
  send?: AuthIssueSend
}>): Promise<"recorded" | "alerted"> {
  const home = args.home ?? join(homedir(), ".trenchcoat")
  await recordAuthIssue({
    path: authIssuesPath(home),
    source: args.source,
    kind: args.kind,
    at: args.at,
    ...(args.detail ? { detail: args.detail } : {}),
  })
  const notified = await notifyConcurrentAuthIssues({
    home,
    ...(args.send ? { send: args.send } : {}),
    nowIso: args.at,
  })
  return notified === "sent" ? "alerted" : "recorded"
}

export async function reportSessionAuthFailureCode(args: Readonly<{
  source: AuthIssueSource
  code: string
  at: string
  detail?: string
  home?: string
  send?: AuthIssueSend
}>): Promise<"recorded" | "alerted" | "ignored"> {
  if (!isSessionAuthFailureCode(args.code)) return "ignored"
  const kind = authKindFromFailureCode(args.code)
  if (!kind) return "ignored"
  return reportSessionAuthIssue({
    source: args.source,
    kind,
    at: args.at,
    ...(args.detail ? { detail: args.detail } : {}),
    ...(args.home ? { home: args.home } : {}),
    ...(args.send ? { send: args.send } : {}),
  })
}

export async function clearSessionAuthIssue(args: Readonly<{
  source: AuthIssueSource
  home?: string
}>): Promise<void> {
  const home = args.home ?? join(homedir(), ".trenchcoat")
  await clearAuthIssue({
    path: authIssuesPath(home),
    source: args.source,
  })
}

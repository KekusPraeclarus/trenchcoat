import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  applyAssistantDelta,
  createNdjsonParser,
  extractAssistantText,
  extractResultText,
  extractStreamError,
} from "../lib/cursor-stream.js"
import { log } from "../lib/log.js"

export type SessionMode = "ask" | "plan"
export type SessionOutputFormat = "text" | "json" | "stream-json"

export type SessionOptions = Readonly<{
  prompt: string
  cwd: string
  model?: string
  sandbox?: boolean
  /** Optional override; default resolves `agent` then `cursor-agent` from PATH / ~/.local/bin */
  bin?: string
  timeoutMs?: number
  /** Optional API key — prefer CLI login (`agent login`). Only passed if set. */
  apiKey?: string
  resumeChatId?: string
  /** Read-only Q&A (`ask`) or planning (`plan`); omit for normal tool-enabled runs */
  mode?: SessionMode
  outputFormat?: SessionOutputFormat
  streamPartial?: boolean
  /** Invoked with accumulated assistant text as stream-json deltas arrive */
  onPartial?: (text: string) => void | Promise<void>
}>

export type SessionResult = Readonly<{
  status: "finished" | "error"
  agentId?: string
  text?: string
  error?: string
  exitCode?: number
}>

const DEFAULT_MODEL = "composer-2.5"

/** Resolve Cursor CLI binary installed via https://cursor.com/docs/cli/installation */
export function resolveCursorCliBin(explicit?: string): string {
  if (explicit && existsSync(explicit)) return explicit
  const home = homedir()
  const candidates = [
    explicit,
    process.env["TRENCHCOAT_CURSOR_BIN"]?.trim(),
    join(home, ".local", "bin", "agent"),
    join(home, ".local", "bin", "cursor-agent"),
    "agent",
    "cursor-agent",
  ].filter((value): value is string => Boolean(value))

  for (const candidate of candidates) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (existsSync(candidate)) return candidate
      continue
    }
    return candidate
  }
  return "agent"
}

/** Headless argv — login auth, no CURSOR_API_KEY required */
export function buildCursorCliArgs(opts: Readonly<{
  prompt: string
  cwd: string
  model?: string
  sandbox?: boolean
  apiKey?: string
  resumeChatId?: string
  mode?: SessionMode
  outputFormat?: SessionOutputFormat
  streamPartial?: boolean
}>): string[] {
  assertPathOnlyPrompt(opts.prompt)
  const outputFormat = opts.outputFormat ?? "text"
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    outputFormat,
    "--trust",
    "--workspace",
    opts.cwd,
    "--model",
    opts.model ?? DEFAULT_MODEL,
    "--sandbox",
    opts.sandbox === false ? "disabled" : "enabled",
  ]
  if (opts.streamPartial) {
    if (outputFormat !== "stream-json") {
      throw new Error("streamPartial requires outputFormat stream-json")
    }
    args.push("--stream-partial-output")
  }
  if (opts.mode) {
    args.push("--mode", opts.mode)
  }
  if (opts.resumeChatId) {
    args.push("--resume", opts.resumeChatId)
  }
  if (opts.apiKey) {
    args.push("--api-key", opts.apiKey)
  }
  return args
}

/** Allocate a durable Cursor chat id for resumable operator conversations */
export async function createCursorChat(bin = resolveCursorCliBin()): Promise<string> {
  const result = await runCapture(bin, ["create-chat"], 30_000)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `create-chat exited ${result.exitCode}`)
  }
  const id = result.stdout.trim().split(/\s+/u)[0] ?? ""
  if (!/^[0-9a-f-]{16,}$/iu.test(id)) {
    throw new Error(`create-chat returned unexpected id: ${result.stdout.trim().slice(0, 80)}`)
  }
  return id
}

export async function probeCursorCli(bin = resolveCursorCliBin()): Promise<{
  ok: boolean
  version?: string
  loggedIn: boolean
  detail: string
}> {
  try {
    const version = await runCapture(bin, ["--version"], 10_000)
    const status = await runCapture(bin, ["status"], 15_000)
    const loggedIn = /logged in/iu.test(status.stdout + status.stderr)
    return {
      ok: version.exitCode === 0 && loggedIn,
      version: version.stdout.trim() || version.stderr.trim(),
      loggedIn,
      detail: loggedIn ? "cli login present" : "run `agent login`",
    }
  } catch (error) {
    return {
      ok: false,
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/** One-shot local Cursor CLI session. Never interpolate scraped text into prompt. */
export async function runOneShotSession(opts: SessionOptions): Promise<SessionResult> {
  const bin = resolveCursorCliBin(opts.bin)
  const args = buildCursorCliArgs({
    prompt: opts.prompt,
    cwd: opts.cwd,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.sandbox === undefined ? {} : { sandbox: opts.sandbox }),
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.resumeChatId ? { resumeChatId: opts.resumeChatId } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.outputFormat ? { outputFormat: opts.outputFormat } : {}),
    ...(opts.streamPartial ? { streamPartial: true } : {}),
  })

  log.info("cursor cli session start", { bin, model: opts.model ?? DEFAULT_MODEL, cwd: opts.cwd })
  try {
    if (opts.outputFormat === "stream-json") {
      return await runStreamCapture(bin, args, opts.timeoutMs ?? 15 * 60_000, opts.cwd, opts.onPartial)
    }
    const result = await runCapture(bin, args, opts.timeoutMs ?? 15 * 60_000, opts.cwd)
    if (result.exitCode !== 0) {
      return {
        status: "error",
        text: result.stdout,
        error: result.stderr || `cursor cli exited ${result.exitCode}`,
        exitCode: result.exitCode,
      }
    }
    return {
      status: "finished",
      agentId: "cursor-cli",
      text: result.stdout.trim(),
      exitCode: 0,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error("session failed", { detail: message })
    return { status: "error", error: message }
  }
}

/** Chat path: stream-json + partial deltas, optional onPartial sink */
export async function runStreamingSession(opts: SessionOptions): Promise<SessionResult> {
  return runOneShotSession({
    ...opts,
    outputFormat: "stream-json",
    streamPartial: true,
  })
}

function runStreamCapture(
  bin: string,
  args: readonly string[],
  timeoutMs: number,
  cwd: string | undefined,
  onPartial?: (text: string) => void | Promise<void>,
): Promise<SessionResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, [...args], {
      cwd,
      env: scrubChildEnv(process.env),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stderr = ""
    let accumulated = ""
    let finalText: string | undefined
    let streamError: string | undefined
    let timedOut = false
    let partialChain: Promise<void> = Promise.resolve()

    const parser = createNdjsonParser((event) => {
      const err = extractStreamError(event)
      if (err) streamError = err
      const resultText = extractResultText(event)
      if (resultText !== undefined) finalText = resultText
      const delta = extractAssistantText(event)
      if (delta === undefined) return
      accumulated = applyAssistantDelta(accumulated, delta)
      if (onPartial) {
        const snapshot = accumulated
        partialChain = partialChain.then(() => Promise.resolve(onPartial(snapshot)))
      }
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, timeoutMs)

    child.stdout.on("data", (chunk: Buffer) => {
      parser.push(chunk.toString("utf8"))
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      const text = accumulated.trim()
      resolve({
        status: "error",
        error: error.message,
        ...(text ? { text } : {}),
      })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      parser.flush()
      void partialChain.then(() => {
        const text = (finalText ?? accumulated).trim()
        if (code !== 0) {
          resolve({
            status: "error",
            ...(text ? { text } : {}),
            error: timedOut
              ? `cursor cli timed out after ${timeoutMs}ms`
              : streamError || stderr || `cursor cli exited ${code ?? 1}`,
            exitCode: code ?? 1,
          })
          return
        }
        if (streamError) {
          resolve({
            status: "error",
            ...(text ? { text } : {}),
            error: streamError,
            exitCode: 0,
          })
          return
        }
        resolve({
          status: "finished",
          agentId: "cursor-cli",
          text,
          exitCode: 0,
        })
      })
    })
  })
}

export function assertPathOnlyPrompt(prompt: string): void {
  if (/inbox\/[^\s]+[\n\r].{200,}/u.test(prompt) && prompt.includes("ignore previous")) {
    throw new Error("Prompt appears to interpolate scraped content")
  }
  if (prompt.includes("CURSOR_API_KEY") || prompt.includes("TRENCHCOAT_ROUTER_TOKEN")) {
    throw new Error("Prompt must not contain secrets")
  }
}

function runCapture(
  bin: string,
  args: readonly string[],
  timeoutMs: number,
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], {
      cwd,
      env: scrubChildEnv(process.env),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new Error(`cursor cli timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8") })
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8") })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code ?? 1 })
    })
  })
}

/** Host-side secrets that must never reach the Cursor child process */
export const SCRUBBED_CHILD_ENV_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CURSOR_API_KEY",
  "TRENCHCOAT_ROUTER_URL",
  "TRENCHCOAT_ROUTER_TOKEN",
  "TRENCHCOAT_ROUTER_HMAC_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_OPERATOR_ID",
  "TELEGRAM_ROUTER_BOT_TOKEN",
  "TELEGRAM_ROUTER_CHAT_ID",
  "TELEGRAM_API_ID",
  "TELEGRAM_API_HASH",
  "GOPLUS_APP_KEY",
  "GOPLUS_APP_SECRET",
  "COINGECKO_DEMO_KEY",
  "NEYNAR_API_KEY",
  "NEYNAR_WALLET_ID",
  "FARCASTER_APP_FID",
  "FARCASTER_APP_MNEMONIC",
  "HELIUS_API_KEY",
  "INFURA_API_KEY",
  "DISCORD_WEBHOOK_URL",
  "DISCORD_RESEARCH_BOT_TOKEN",
  "TAVILY_API_KEY",
] as const)

export function scrubChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  for (const key of SCRUBBED_CHILD_ENV_KEYS) {
    delete next[key]
  }
  return next
}

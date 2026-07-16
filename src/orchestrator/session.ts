import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { log } from "../lib/log.js"

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
}>): string[] {
  assertPathOnlyPrompt(opts.prompt)
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "text",
    "--trust",
    "--workspace",
    opts.cwd,
    "--model",
    opts.model ?? DEFAULT_MODEL,
    "--sandbox",
    opts.sandbox === false ? "disabled" : "enabled",
  ]
  if (opts.resumeChatId) {
    args.push("--resume", opts.resumeChatId)
  }
  if (opts.apiKey) {
    args.push("--api-key", opts.apiKey)
  }
  return args
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
  })

  log.info("cursor cli session start", { bin, model: opts.model ?? DEFAULT_MODEL, cwd: opts.cwd })
  try {
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

function scrubChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  // Prefer CLI login; do not force SDK/cloud key paths unless explicitly opted in via --api-key
  delete next["ANTHROPIC_API_KEY"]
  delete next["OPENAI_API_KEY"]
  return next
}

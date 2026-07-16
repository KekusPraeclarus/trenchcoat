import { Agent } from "@cursor/sdk"
import { log } from "../lib/log.js"

export type SessionOptions = Readonly<{
  apiKey: string
  model?: string
  prompt: string
  cwd: string
  sandbox?: boolean
}>

export type SessionResult = Readonly<{
  status: "finished" | "error"
  agentId?: string
  text?: string
  error?: string
}>

/** One-shot local Cursor session. Never interpolate scraped text into prompt. */
export async function runOneShotSession(opts: SessionOptions): Promise<SessionResult> {
  const model = opts.model ?? "composer-2.5"
  let agent: Awaited<ReturnType<typeof Agent.create>> | undefined
  try {
    agent = await Agent.create({
      apiKey: opts.apiKey,
      model,
      local: {
        cwd: opts.cwd,
        // Setting sources empty — host owns instructions under agent/
      },
    } as never)

    const run = await agent.send(opts.prompt)
    // SDK shapes evolve; wait if available
    if (run && typeof (run as { wait?: () => Promise<unknown> }).wait === "function") {
      await (run as { wait: () => Promise<unknown> }).wait()
    }
    return {
      status: "finished",
      agentId: String((agent as { agentId?: string }).agentId ?? "unknown"),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error("session failed", { detail: message })
    return { status: "error", error: message }
  } finally {
    try {
      await (agent as { [Symbol.asyncDispose]?: () => Promise<void> } | undefined)?.[Symbol.asyncDispose]?.()
    } catch {
      /* ignore */
    }
  }
}

export function assertPathOnlyPrompt(prompt: string): void {
  if (/inbox\/[^\s]+[\n\r].{200,}/u.test(prompt) && prompt.includes("ignore previous")) {
    throw new Error("Prompt appears to interpolate scraped content")
  }
  if (prompt.includes("CURSOR_API_KEY")) {
    throw new Error("Prompt must not contain secrets")
  }
}

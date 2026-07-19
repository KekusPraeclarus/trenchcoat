import { readFileSync, existsSync, mkdirSync, cpSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { discordLayout } from "./paths.js"

const RESEARCH_SKILL_FILES = [
  "deep-research/SKILL.md",
  "research/SKILL.md",
] as const

const DISCORD_AGENTS_MD = `# trenchcoat Discord research agent

You run isolated deep research for Discord operator requests.
Follow skills/deep-research/SKILL.md and skills/research/SKILL.md.
Do not reference main agent paths, Telegram, watchlist mutations, or broadcast flows.
Write only under this workspace.
`

export function ensureDiscordAgentWorkspace(
  repoRoot: string,
  layout = discordLayout(),
): string {
  const agentRoot = layout.agent
  mkdirSync(join(agentRoot, "inbox"), { recursive: true, mode: 0o700 })
  mkdirSync(join(agentRoot, "reports"), { recursive: true, mode: 0o700 })
  mkdirSync(join(agentRoot, "reports", "chat"), { recursive: true, mode: 0o700 })
  mkdirSync(join(agentRoot, "skills"), { recursive: true, mode: 0o700 })
  mkdirSync(join(agentRoot, "state"), { recursive: true, mode: 0o700 })

  const agentsPath = join(agentRoot, "AGENTS.md")
  if (!existsSync(agentsPath)) {
    mkdirSync(agentRoot, { recursive: true, mode: 0o700 })
    writeFileSync(agentsPath, DISCORD_AGENTS_MD, { mode: 0o600 })
  }

  for (const rel of RESEARCH_SKILL_FILES) {
    const src = join(repoRoot, "agent", "skills", rel)
    const dest = join(agentRoot, "skills", rel)
    if (existsSync(src)) {
      mkdirSync(join(dest, ".."), { recursive: true, mode: 0o700 })
      cpSync(src, dest, { force: true })
    }
  }

  return agentRoot
}

export function readDiscordChatReport(agentRoot: string, runId: string): string | undefined {
  const path = join(agentRoot, "reports", "chat", `${runId}.md`)
  if (!existsSync(path)) return undefined
  return readFileSync(path, "utf8")
}

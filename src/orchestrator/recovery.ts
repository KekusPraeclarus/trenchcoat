import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import type { RunJournal } from "./journal.js"

export type RecoveryAction = "resume" | "nothing"

export function recoveryAction(journal: RunJournal): RecoveryAction {
  return journal.phase === "complete" ? "nothing" : "resume"
}

export async function discardIncompleteInbox(agentRoot: string, runId: string): Promise<void> {
  const path = join(agentRoot, "inbox", runId)
  if (existsSync(path)) await rm(path, { recursive: true, force: true })
}

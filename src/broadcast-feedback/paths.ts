import { homedir } from "node:os"
import { join } from "node:path"

export type BroadcastFeedbackLayout = Readonly<{
  root: string
  /** Append-only reaction and follow-up events */
  ledger: string
  /** Open Telegram detail requests, keyed by feedbackId */
  pendingFollowups: string
  /** One confined evidence file per natural-language reply */
  followupEvidence: string
  /** Sealed datasets and tuning candidates */
  sealed: string
  candidates: string
  lock: string
}>

export function broadcastFeedbackHome(home = join(homedir(), ".trenchcoat")): string {
  return join(home, "broadcast-feedback")
}

export function broadcastFeedbackLayout(
  home = join(homedir(), ".trenchcoat"),
): BroadcastFeedbackLayout {
  const root = broadcastFeedbackHome(home)
  return {
    root,
    ledger: join(root, "ledger.jsonl"),
    pendingFollowups: join(root, "pending-followups.json"),
    followupEvidence: join(root, "followup-evidence"),
    sealed: join(root, "sealed"),
    candidates: join(root, "candidates"),
    lock: join(root, ".lock"),
  }
}

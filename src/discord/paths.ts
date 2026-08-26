import { homedir } from "node:os"
import { join } from "node:path"

export type DiscordLayout = Readonly<{
  root: string
  requests: string
  watchlist: string
  observations: string
  deliveries: string
  tracking: string
  conversations: string
  conversationSessions: string
  agent: string
  archive: string
  archiveRuns: string
  archiveSkips: string
  listenerHeartbeat: string
  monitorHeartbeat: string
  lock: string
  /** Long-held: research vs monitor exclusivity (never blocks intake) */
  workerLock: string
  monitorCursor: string
  walletSignalCursors: string
}>

/** Tests set HOME. Prefer that over os.homedir(), which can ignore HOME. */
function defaultTrenchcoatRoot(): string {
  const home = process.env["HOME"]?.trim() || homedir()
  return join(home, ".trenchcoat")
}

export function discordHome(home = defaultTrenchcoatRoot()): string {
  return join(home, "discord")
}

export function discordLayout(home = defaultTrenchcoatRoot()): DiscordLayout {
  const root = discordHome(home)
  return {
    root,
    requests: join(root, "requests.json"),
    watchlist: join(root, "watchlist.json"),
    observations: join(root, "observations.json"),
    deliveries: join(root, "deliveries.json"),
    tracking: join(root, "tracking.json"),
    conversations: join(root, "conversations.json"),
    conversationSessions: join(root, "conversation-sessions.json"),
    agent: join(root, "agent"),
    archive: join(root, "archive"),
    archiveRuns: join(root, "archive", "runs"),
    archiveSkips: join(root, "archive", "skips"),
    listenerHeartbeat: join(root, "listener-heartbeat.json"),
    monitorHeartbeat: join(root, "monitor-heartbeat.json"),
    lock: join(root, ".lock"),
    workerLock: join(root, ".worker.lock"),
    monitorCursor: join(root, "monitor-cursor.json"),
    walletSignalCursors: join(root, "wallet-signal-cursors.json"),
  }
}

export function discordLockPath(layout: DiscordLayout): string {
  return layout.lock
}

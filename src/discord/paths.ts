import { homedir } from "node:os"
import { join } from "node:path"

export type DiscordLayout = Readonly<{
  root: string
  requests: string
  watchlist: string
  observations: string
  deliveries: string
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
}>

export function discordHome(home = join(homedir(), ".trenchcoat")): string {
  return join(home, "discord")
}

export function discordLayout(home = join(homedir(), ".trenchcoat")): DiscordLayout {
  const root = discordHome(home)
  return {
    root,
    requests: join(root, "requests.json"),
    watchlist: join(root, "watchlist.json"),
    observations: join(root, "observations.json"),
    deliveries: join(root, "deliveries.json"),
    agent: join(root, "agent"),
    archive: join(root, "archive"),
    archiveRuns: join(root, "archive", "runs"),
    archiveSkips: join(root, "archive", "skips"),
    listenerHeartbeat: join(root, "listener-heartbeat.json"),
    monitorHeartbeat: join(root, "monitor-heartbeat.json"),
    lock: join(root, ".lock"),
    workerLock: join(root, ".worker.lock"),
    monitorCursor: join(root, "monitor-cursor.json"),
  }
}

export function discordLockPath(layout: DiscordLayout): string {
  return layout.lock
}

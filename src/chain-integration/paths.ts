import { homedir } from "node:os"
import { join } from "node:path"
import { discordHome } from "../discord/paths.js"

export type ChainIntegrationLayout = Readonly<{
  root: string
  index: string
  lock: string
  workerLock: string
  artifacts: string
  journal: string
}>

export function chainIntegrationLayout(
  home = join(homedir(), ".trenchcoat"),
): ChainIntegrationLayout {
  const root = join(discordHome(home), "chain-integrations")
  return {
    root,
    index: join(root, "index.json"),
    lock: join(root, ".lock"),
    workerLock: join(root, ".worker.lock"),
    artifacts: join(root, "artifacts"),
    journal: join(root, "journal"),
  }
}

export function integrationArtifactDir(
  layout: ChainIntegrationLayout,
  integrationId: string,
): string {
  return join(layout.artifacts, integrationId)
}

export function repoMutationLockPath(home = join(homedir(), ".trenchcoat")): string {
  return join(home, "repo-mutation.lock")
}

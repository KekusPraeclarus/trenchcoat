import { homedir } from "node:os"
import { join } from "node:path"

export type RemediationLayout = Readonly<{
  root: string
  index: string
  lock: string
  workerLock: string
  artifacts: string
  journal: string
  cursors: string
  deferred: string
  sourceHealthLedger: string
}>

export function remediationHome(home = join(homedir(), ".trenchcoat")): string {
  return join(home, "remediations")
}

export function remediationLayout(
  home = join(homedir(), ".trenchcoat"),
): RemediationLayout {
  const root = remediationHome(home)
  return {
    root,
    index: join(root, "index.json"),
    lock: join(root, ".lock"),
    workerLock: join(root, ".worker.lock"),
    artifacts: join(root, "artifacts"),
    journal: join(root, "journal"),
    cursors: join(root, "cursors.json"),
    deferred: join(root, "deferred.json"),
    sourceHealthLedger: join(root, "source-health-ledger.json"),
  }
}

export function incidentArtifactDir(
  layout: RemediationLayout,
  incidentId: string,
): string {
  return join(layout.artifacts, incidentId)
}

export function remediationWorktreePath(
  repoRoot: string,
  incidentId: string,
): string {
  return join(repoRoot, "..", `trench-bot-remediation-${incidentId}`)
}

export function remediationBranchName(incidentId: string): string {
  return `remediation/${incidentId}`
}

export { repoMutationLockPath } from "../chain-integration/paths.js"

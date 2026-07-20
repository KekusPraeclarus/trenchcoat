import { log } from "../lib/log.js"
import { runJob } from "./run.js"

export type ResearchDrainPaths = Readonly<{
  agentRoot: string
  archiveRoot: string
}>

let pumping = false
let pendingKick = false
let activePaths: ResearchDrainPaths | undefined

/**
 * Kick a host-side research drain after enqueue. Safe to call under the
 * workspace lock — the pump waits until the caller releases it.
 * Drains due entries until empty, daily-cap, or a non-busy failure.
 */
export function scheduleResearchDrain(paths: ResearchDrainPaths): void {
  activePaths = paths
  pendingKick = true
  void pumpResearchDrain()
}

async function pumpResearchDrain(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    while (pendingKick) {
      pendingKick = false
      const paths = activePaths
      if (!paths) break
      for (;;) {
        let result: Awaited<ReturnType<typeof runJob>>
        try {
          result = await runJob({
            job: "research",
            paths,
          })
        } catch (error) {
          log.error("research drain failed", {
            detail: error instanceof Error ? error.message : "unknown",
          })
          break
        }
        if (result.exitCode === 3) {
          // Another writer holds the lock — retry shortly
          pendingKick = true
          await sleep(2_000)
          break
        }
        if (result.runId === "none" || result.exitCode !== 0) break
        // More due entries may remain — continue under the same kick
      }
    }
  } finally {
    pumping = false
    if (pendingKick) void pumpResearchDrain()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Test helper — reset pump state between cases */
export function resetResearchDrainForTests(): void {
  pumping = false
  pendingKick = false
  activePaths = undefined
}

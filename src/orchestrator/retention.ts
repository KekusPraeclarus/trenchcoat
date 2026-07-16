import { readdirSync, statSync, rmSync } from "node:fs"
import { join } from "node:path"

export function retainByAge(
  dir: string,
  maxAgeDays: number,
  nowMs = Date.now(),
): string[] {
  const removed: string[] = []
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return removed
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const st = statSync(path)
    const ageDays = (nowMs - st.mtimeMs) / 86_400_000
    if (ageDays > maxAgeDays) {
      rmSync(path, { recursive: true, force: true })
      removed.push(path)
    }
  }
  return removed
}

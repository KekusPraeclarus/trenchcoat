const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

export function createRunId(job: string, when = new Date()): string {
  const stamp = when.toISOString().replace(/[:.]/gu, "-")
  const id = `${job}-${stamp}`
  assertRunId(id)
  return id
}

export function assertRunId(runId: string): void {
  if (!SAFE_ID.test(runId)) {
    throw new TypeError("Run id is invalid")
  }
}

export type PreflightResult = Readonly<{
  ok: boolean
  checks: ReadonlyArray<{ name: string; ok: boolean; detail: string }>
}>

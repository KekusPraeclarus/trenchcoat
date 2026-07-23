import type { CanonicalIdentity, LedgerPosition, LedgerFile } from "../contracts/schemas.js"

export type Observation = Readonly<{
  ts: string
  open: number
  hash: `sha256:${string}`
}>

export function openEntryPending(args: Readonly<{
  positionId: string
  decisionId: string
  identity: CanonicalIdentity
  openedAt: string
}>): LedgerPosition {
  return {
    schema: 1,
    positionId: args.positionId,
    decisionId: args.decisionId,
    identity: args.identity,
    status: "entry-pending",
    openedAt: args.openedAt,
  }
}

/** First eligible observation strictly after decision/drop timestamp */
export function firstEligibleObservation(
  decisionTs: string,
  observations: readonly Observation[],
): Observation | undefined {
  const cutoff = Date.parse(decisionTs)
  return observations
    .filter((o) => Date.parse(o.ts) > cutoff && Number.isFinite(o.open) && o.open > 0)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))[0]
}

export function finalizeEntry(
  position: LedgerPosition,
  observation: Observation,
): LedgerPosition {
  if (position.status !== "entry-pending") {
    throw new Error("Position is not entry-pending")
  }
  return {
    ...position,
    status: "open",
    entryPrice: observation.open,
    entryObservationHash: observation.hash,
  }
}

export function markExitPending(position: LedgerPosition): LedgerPosition {
  if (position.status !== "open") throw new Error("Position is not open")
  return { ...position, status: "exit-pending" }
}

/** Drop before a fill — never invent an entry price */
export function cancelEntryPending(
  position: LedgerPosition,
  closedAt: string,
): LedgerPosition {
  if (position.status !== "entry-pending") {
    throw new Error("Position is not entry-pending")
  }
  return { ...position, status: "censored", closedAt }
}

export function finalizeExit(
  position: LedgerPosition,
  observation: Observation,
  closedAt: string,
): LedgerPosition {
  if (position.status !== "exit-pending") {
    throw new Error("Position is not exit-pending")
  }
  return {
    ...position,
    status: "closed",
    exitPrice: observation.open,
    exitObservationHash: observation.hash,
    closedAt,
  }
}

export function upsertPosition(file: LedgerFile, position: LedgerPosition): LedgerFile {
  const others = file.positions.filter((p) => p.positionId !== position.positionId)
  return { schema: 1, positions: [...others, position] }
}

export function actionRealizedReturn(position: LedgerPosition): number | undefined {
  if (
    position.status !== "closed"
    || position.entryPrice === undefined
    || position.exitPrice === undefined
  ) {
    return undefined
  }
  return (position.exitPrice - position.entryPrice) / position.entryPrice
}

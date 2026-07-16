import { sha256Json } from "../lib/canonical-json.js"
import { renderWalletLifecycleLine } from "../lib/router-contract.js"
import type { WalletRecord, WalletTransition, RouterEvent } from "../contracts/schemas.js"

export function buildWalletTransition(args: Readonly<{
  wallet: WalletRecord
  action: "added" | "dropped"
  reasonCode: string
  reasonLine: string
  occurredAt: string
  runId: string
  evidenceHash: `sha256:${string}`
}>): WalletTransition {
  const transitionId = sha256Json({
    walletId: args.wallet.walletId,
    action: args.action,
    reasonCode: args.reasonCode,
    occurredAt: args.occurredAt,
    evidenceHash: args.evidenceHash,
  })
  return {
    schema: 1,
    transitionId,
    walletId: args.wallet.walletId,
    chain: args.wallet.chain,
    address: args.wallet.address,
    action: args.action,
    reasonCode: args.reasonCode,
    reasonLine: args.reasonLine.slice(0, 280),
    occurredAt: args.occurredAt,
    runId: args.runId,
    evidenceHash: args.evidenceHash,
  }
}

export function transitionToRouterEvent(transition: WalletTransition): RouterEvent {
  const text = renderWalletLifecycleLine({
    action: transition.action,
    chain: transition.chain,
    address: transition.address,
    reasonLine: transition.reasonLine,
  })
  return {
    schema: 1,
    eventId: transition.transitionId,
    occurredAt: transition.occurredAt,
    runId: transition.runId,
    type: "wallet.lifecycle",
    severity: "lifecycle",
    text,
    refs: [`state/wallets.json`],
    walletTransition: {
      walletId: transition.walletId,
      chain: transition.chain,
      address: transition.address,
      action: transition.action,
      reasonCode: transition.reasonCode,
      reasonLine: transition.reasonLine,
    },
  }
}

export function applyTransitionsCap<T>(items: readonly T[], max: number): {
  applied: T[]
  queued: T[]
} {
  return {
    applied: items.slice(0, max),
    queued: items.slice(max),
  }
}

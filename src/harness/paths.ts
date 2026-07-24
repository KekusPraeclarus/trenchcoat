import {
  DECISION_POLICY_REL_PATH as SCHEMA_POLICY_PATH,
  IMPROVER_CONFIG_ALLOWLIST_PATH as SCHEMA_IMPROVER_PATH,
} from "../contracts/schemas.js"

export const DECISION_POLICY_REL_PATH = SCHEMA_POLICY_PATH
export const IMPROVER_CONFIG_REL_PATH = SCHEMA_IMPROVER_PATH

export const POLICY_ALLOWLIST = [DECISION_POLICY_REL_PATH] as const
export const IMPROVER_CONFIG_ALLOWLIST = [IMPROVER_CONFIG_REL_PATH] as const

export type HarnessLane = "policy" | "meta"

export function allowlistForLane(lane: HarnessLane): readonly string[] {
  return lane === "meta" ? IMPROVER_CONFIG_ALLOWLIST : POLICY_ALLOWLIST
}

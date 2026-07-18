/**
 * intent-session — isolated, leniency-bounded, fail-closed intent classifier
 * (INV-S13). Deterministic CA-matching cannot tell shilling from warning, so each
 * matched item passes through a fresh session running the fixed host prompt with
 * the single message supplied as quoted data (never interpolated into the prompt).
 *
 * Fail-closed everywhere: a missing runner, a session error, an unparseable
 * output, or an exhausted daily cap all resolve to `shill`. Only a clean `warn`
 * output can attenuate a dock — leniency is the classifier's ceiling.
 */

import { INTENT_CLASSIFIER_PROMPT } from "../prompts/host.js"
import { intentPrompt, parseIntentVerdict, type IntentVerdict } from "./intent.js"

export type IntentSessionRunner = (
  args: Readonly<{ prompt: string; message: string }>,
) => Promise<string>

export type IntentClassifierArgs = Readonly<{
  text: string
  dailyCap: number
  usedToday: number
  runSession?: IntentSessionRunner
}>

export type IntentClassifierResult = Readonly<{
  verdict: IntentVerdict
  capExhausted: boolean
  // classifications consumed after this call; only a launched session consumes one
  used: number
}>

export async function runIntentClassifier(
  args: IntentClassifierArgs,
): Promise<IntentClassifierResult> {
  // Exhaustion cannot suppress a dock: remaining matches fail closed to shill and
  // the caller raises an operator-visible capacity incident.
  if (args.usedToday >= args.dailyCap) {
    return { verdict: "shill", capExhausted: true, used: args.usedToday }
  }

  if (!args.runSession) {
    return { verdict: "shill", capExhausted: false, used: args.usedToday }
  }

  const used = args.usedToday + 1
  try {
    const raw = await args.runSession({
      prompt: INTENT_CLASSIFIER_PROMPT,
      message: intentPrompt(args.text),
    })
    return { verdict: parseIntentVerdict(raw), capExhausted: false, used }
  } catch {
    return { verdict: "shill", capExhausted: false, used }
  }
}

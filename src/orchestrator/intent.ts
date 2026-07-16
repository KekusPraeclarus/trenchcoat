export type IntentVerdict = "shill" | "warn"

export function parseIntentVerdict(output: string): IntentVerdict {
  const token = output.trim().toLowerCase().split(/\s+/u)[0]
  return token === "warn" ? "warn" : "shill"
}

export function intentPrompt(message: string): string {
  return `Classify the quoted message as exactly shill or warn.\n<untrusted-message>\n${message}\n</untrusted-message>`
}

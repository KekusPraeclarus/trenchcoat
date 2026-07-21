/** Strip Discord mention/channel/URL forms from model-authored reason text */
export function sanitizeTrackingReason(raw: string, max = 200): string {
  let text = raw.normalize("NFKC")
  // Control + bidi overrides
  text = text.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/gu, "")
  // Markdown links before URL strip so the whole [label](url) goes away
  text = text.replace(/\[[^\]]*\]\([^)]*\)/gu, "")
  text = text.replace(/<@!?\d+>/gu, "")
  text = text.replace(/<@&\d+>/gu, "")
  text = text.replace(/<#\d+>/gu, "")
  text = text.replace(/<a?:\w+:\d+>/gu, "")
  text = text.replace(/<t:\d+(?::[tTdDfFR])?>/gu, "")
  text = text.replace(/@(?:everyone|here)\b/giu, "")
  text = text.replace(/https?:\/\/\S+/giu, "")
  text = text.replace(/\s+/gu, " ").trim()
  return text.slice(0, max)
}

export function escapeDiscordLabel(label: string): string {
  return label.replace(/[@`*_~|\\]/gu, "").replace(/\s+/gu, " ").trim().slice(0, 64)
}

export function renderTrackingPing(userId: string, reason: string): string {
  const clean = sanitizeTrackingReason(reason)
  const body = clean.length > 0 ? clean : "a matching project"
  return `<@${userId}> I see talk of ${body}`
}

export function renderCapacityMessage(
  activeLabels: readonly string[],
  maxActive: number,
): string {
  const lines = activeLabels.map((label) => `- ${escapeDiscordLabel(label)}`)
  return [
    `You're at your limit of ${maxActive} tracked requests. Drop one to start this:`,
    ...lines,
  ].join("\n").slice(0, 2_000)
}

export function renderExpiryNotice(args: Readonly<{
  userId: string
  labels: readonly string[]
}>): string {
  const labels = args.labels.map(escapeDiscordLabel).filter(Boolean)
  if (labels.length <= 1) {
    const label = labels[0] ?? "your request"
    return [
      `<@${args.userId}> your request to track ${label} has expired.`,
      "Do you want to extend another month? (yes/no)",
    ].join(" ").slice(0, 2_000)
  }
  return [
    `<@${args.userId}> you have a few tracking requests about to expire. Which do you want to extend?`,
    ...labels.map((label) => `- ${label}`),
  ].join("\n").slice(0, 2_000)
}

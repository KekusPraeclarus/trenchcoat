---
title: "030 — Host-authoritative Telegram remediation approvals"
status: accepted
date: 2026-07-23
last_verified: 2026-08-18
---

# ADR 030: Host-authoritative Telegram remediation approvals

## Context

High-risk remediations send Telegram approval cards ending in
`approve remediation rem-<id>`. Operators typed variants such as
`approve remediation Rem 92da03a5713e` (capital R, space instead of hyphen).
The host regex required `rem-<token>` as a single token, so parsing returned
null and the message fell through to the general chat agent. The agent replied
“Approval noted” without mutating the remediations ledger — operators believed
they had approved while incidents stayed `awaiting-approval`.

Dense key=value approval cards were also hard to act on; operators wanted a
short briefing in assistant voice with copy-pasteable command lines.

## Decision

1. **Host parse first.** Exact `approve|defer|reject remediation …` commands
   (and `/remediations` / `remediation <id>`) are handled by
   `handleRemediationChatCommand` before any Cursor chat turn (INV-B3 allowlist
   unchanged).
2. **Normalize incident ids.** `normalizeRemediationIncidentId` accepts
   `rem-<id>`, `Rem <hex>`, `rem_<hex>`, and embedded forms → canonical
   `rem-<lowercase>`.
3. **Forwarded agent intent.** If a message still reaches chat, host re-reads
   the agent reply for approval language + rem id
   (`parseForwardedRemediationIntent`, including “Approval noted — Rem …”) and
   applies the same host gates (hash, expiry, single-use).
4. **Readable cards.** Approval Telegram text is host-composed plain language
   (what happened / proposed fix / touches), optionally polished by
   `composer-2.5` in assistant voice; the three exact command lines must remain
   verbatim or polish falls back to the host draft (extends ADR 028).
5. **Recovery.** When Telegram missed an intended approve, operators (or desktop
   via `ops/remote.sh`) may `tc remediations approve rem-<id>` on the VPS —
   same host path, same gates.

## Consequences

- Typo’d Telegram approves land on the ledger and kick build.
- Chat agent can no longer “note” an approve without host application when the
  id is recoverable.
- Approval polish adds a small Cursor ask-session cost on high-risk gates.
- Approve kicks a detached `tc remediations run <id>` child. The CLI and
  Telegram listener return at once.

## Alternatives considered

- Buttons / callback_query only — still need text fallback; typo risk remains
  for paste.
- Rely solely on agent forwarded intent — too late; operator already waited on
  a false “noted”.
- Skip hash-bound approval for Discord suggestions — weakens INV-S27.

## Follow-ups

- Shipped in `0570e1c` (+ docs in this ADR).
- Post-approve worker kick is a detached `tc remediations run <id>` child so
  Telegram listener / CLI `approve` return immediately.

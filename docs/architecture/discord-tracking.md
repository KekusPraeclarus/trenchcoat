---
description: Discord idea-tracking requests — NL intake, durable match batches, expiry, INV-D3–D8.
scope: module
status: active
last_verified: 2026-07-21
read_when:
  - Editing src/discord/tracking-*.ts or chat.discord.tracking config.
  - Changing Discord NL intake, match hooks, expiry, or tracking delivery.
---

# Discord idea tracking

Users @mention or reply to the research bot to watch for ideas in natural
language. Matches against X/FC scans and researched tickers (including FOMO
origin) ping the user and attach research. State lives under
`~/.trenchcoat/discord/tracking.json` (host-owned). Binding decision: **ADR 018**.

## Config

`chat.discord.tracking` (default `enabled: false`):

| Key | Default | Role |
|---|---|---|
| `intent_model` / `match_model` | `composer-2.5` | Classifier + matcher |
| `max_active_per_user` | 10 | Cap per `(guildId, userId)` |
| `ttl_days` | 30 | Active lifetime |
| `expiry_bundle_hours` | 48 | Bundle window for expiry notices |
| `pending_capacity_ttl_hours` | 48 | Cap-wait lifetime |
| `tentative_confirm_window_hours` | 24 | Low-confidence confirm window |
| `expiry_reply_window_days` | 7 | Reply window after notice |
| `match_max_attempts` | 5 | Durable batch retries |
| `retention_days` | 35 | Terminal batch/request prune |

## Intake priority

1. Renew phrases → existing watch renew
2. Deterministic research / chain-integration intent → existing paths
3. Else @mention or reply-to-bot → tracking classifier (`TRACKING_INTENT_PROMPT`)
4. Else ignore

Never asks for confirmation. Success ack is 🫡 on the triggering message after
the state commit. Low confidence → silent `tentative`; a second confirming
message within 24h activates.

## State machine

| Status | Matchable | Notes |
|---|---|---|
| `active` | yes if `expiresAt > now` | Cap-counted |
| `pending-capacity` | no | Waiting for a drop under the 10-cap |
| `tentative` | no | Silent; confirm within 24h |
| `expired-awaiting-reply` | no | Matching stops at expiry |
| `expired-final` / `dropped` | no | Terminal |

Mutations are pure transitions in `tracking-state.ts`, persisted under
`layout.lock` via `createDiscordStore().saveTracking` only.

## Matching

Orchestrator (`list-scan`, `farcaster-scan`, `research`) and Discord research
pump enqueue durable `matchBatches` via `enqueueTrackingMatchBatch` after
sealed artifacts. Worker claims oldest-first, runs path-only
`TRACKING_MATCH_PROMPT` over SnapshotWriter envelopes, allowlists ids, sanitizes
reasons, creates idempotent `trackingDeliveries` keyed by
`(trackingId, normalizedSubject)`.

Parent runs never fail because of matching (INV-D6). Exhausted batches log an
operator-visible warning.

## Delivery

Host renders `<@user> I see talk of <reason>` with
`allowed_mentions.users = [owner]`. Research-origin matches reuse the summary;
X/FC matches enqueue `origin: "tracking"` research (bypasses per-user caps,
still counts server daily). Ambiguous Discord sends are marked `terminal`
without blind resend (INV-D7 PARTIAL).

## Expiry

Monitor sweep (`tc discord watchlist scan`) flips elapsed requests, sends one
bundled notice per user (elapsed + `<48h`, exact 48h excluded), binds
`expiryNoticeMessageId`. Replies classify to extend/decline. Cap-safe extend is
all-or-nothing.

## Invariants

| ID | Claim | Status |
|---|---|---|
| INV-D3 | Host-owned transitions + ownership scope | ENFORCED |
| INV-D4 | Cap ≤10; expired never match | ENFORCED |
| INV-D5 | Path-only composer-2.5; allowlist + sanitize | PARTIAL (live injection eval open) |
| INV-D6 | Durable match batches; parent runs isolated | ENFORCED |
| INV-D7 | Idempotent delivery; no blind ambiguous resend | PARTIAL (Discord API ambiguity) |
| INV-D8 | Model quality thresholds | PARTIAL (opt-in live corpus) |

## Test map

- Unit: `tests/unit/discord-tracking-*.test.ts`
- Property: `tests/property/discord-tracking.test.ts` (`prop_inv_d3`–`d7`)
- Integration: `tests/integration/discord-tracking-*.test.ts`
- Crash: `tests/crash/discord-tracking.test.ts`
- Red-team: `tests/redteam/discord-tracking.test.ts` + static ownership
- Live: `tests/e2e/discord-tracking-model-live.test.ts` (`TRENCHCOAT_LIVE_E2E=1`)

## Live eval archive

Before enabling in production, run the live suite on composer-2.5 and record
here: model, date, corpus hash, intent accuracy, match recall, false-positive
rate, safety failures (must be 0).

## References

- ADR 018 — Discord idea tracking
- ADR 010 — Discord research isolation
- INV-D3–D8 in [INVARIANTS.md](../INVARIANTS.md)

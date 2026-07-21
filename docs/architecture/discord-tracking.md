---
description: Discord idea-tracking requests — NL intake, silent research-first qualification, INV-D3–D8.
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
origin) stay silent until a ticker/CA is host-validated, deep research
resolves a canonical token, and qualification passes — then the bot posts a
non-reply alert with the stored `shortLabel` and the full deep-research
response. State lives under `~/.trenchcoat/discord/tracking.json` (host-owned).
Binding decisions: **ADR 018** (intake/state), **ADR 019** (alert qualification),
**ADR 021** (chain constraint + watch quality gate).

## Config

`chat.discord.tracking` (default `enabled: true`):

| Key | Default | Role |
|---|---|---|
| `intent_model` / `match_model` | `composer-2.5` | Classifier + matcher |
| `mention_review_model` | `composer-2.5-fast` | Three-mention reconsideration |
| `max_active_per_user` | 10 | Cap per `(guildId, userId)` |
| `ttl_days` | 30 | Active lifetime |
| `expiry_bundle_hours` | 48 | Bundle window for expiry notices |
| `pending_capacity_ttl_hours` | 48 | Cap-wait lifetime |
| `tentative_confirm_window_hours` | 24 | Low-confidence confirm window |
| `expiry_reply_window_days` | 7 | Reply window after notice |
| `match_max_attempts` | 5 | Durable batch retries |
| `retention_days` | 35 | Terminal batch/request prune |
| `mention_review_blacklist_days` | 7 | Blacklist after rejected review |

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

## Matching and qualification

Orchestrator (`list-scan`, `farcaster-scan`, `research`) and Discord research
pump enqueue durable `matchBatches` via `enqueueTrackingMatchBatch` after
sealed artifacts. Worker claims oldest-first, runs path-only
`TRACKING_MATCH_PROMPT` over SnapshotWriter envelopes.

Match output is `{trackingId, candidateProvenance, tokenQuery, reason}`:
- `candidateProvenance` must equal one host-supplied candidate provenance
- `tokenQuery` must be a CA, `$TICKER`, or bare ticker that appears in that
  candidate (project-name-only guesses fail closed)
- Host resolves via `resolveResearchSubject` with the request's optional
  `chain` as `chainHint`; empty/ambiguous/unsupported → silent
- **Chain constraint:** when intake stored a canonical `chain` on the request
  (LLM-mapped aliases such as RH→robinhood, SOL→solana, HL/HYPE→hyperliquid),
  any resolve whose identity chain differs is dropped (no delivery, no research).
  No stored chain → any chain allowed

**Initial scan path:** no Discord message. Durably enqueue tracking-origin deep
research. Notify only when `mainTrackEligible === true`. Failures move the
delivery to `awaiting-mentions`. Discord watch subscription for both
tracking-origin and direct research also requires `mainTrackEligible` (ADR 021)
so walk/ignore tokens never produce six-hour updates.

**Three-mention reconsideration:** after non-qualification, accumulate three
unique later provenance IDs (duplicate provenance and byte-normalized text
count once). On the third, run `composer-2.5-fast` mention review. Reject →
`blacklistedUntil = now + 7d`. Approve → one fresh deep research; alert may
include a security hard-fail warning (watch subscribe / main promote still use
existing gates — watch subscribe still needs `mainTrackEligible`).

**Research-origin batches:** require host `mainTrackEligible === true` plus
canonical identity; missing metadata fails closed. Request chain constraint
still applies when present.

## Delivery

Qualified alerts use `sendChannelMessage` (never a reply to the original track
request):

```
@user I found a token matching <shortLabel>

<standard deep research response>
```

`shortLabel` is rendered as stored (sanitized). Only the first part mentions the
owner (`allowed_mentions.users = [owner]`). Ambiguous Discord sends are marked
`terminal` without blind resend (INV-D7 PARTIAL).

Dedupe key is `(trackingId, chain, lowercase tokenAddress)`. `matchedSubjects`
is updated only after a successful delivered alert.

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
| INV-D6 | Durable match batches; silent until qualified | ENFORCED |
| INV-D7 | Idempotent canonical delivery; no blind ambiguous resend | PARTIAL (Discord API ambiguity) |
| INV-D8 | Model quality thresholds | PARTIAL (opt-in live corpus) |

## Test map

- Unit: `tests/unit/discord-tracking-*.test.ts`
- Property: `tests/property/discord-tracking.test.ts` (`prop_inv_d3`–`d7`)
- Integration: `tests/integration/discord-tracking-*.test.ts`
- Crash: `tests/crash/discord-tracking.test.ts`
- Red-team: `tests/redteam/discord-tracking.test.ts` + static ownership
- Live: `tests/e2e/discord-tracking-model-live.test.ts` (`TRENCHCOAT_LIVE_E2E=1`)

## Live eval archive

Feature defaults on. For INV-D8 semantic claims, run the live suite on
composer-2.5 and record here: model, date, corpus hash, intent accuracy, match
recall, false-positive rate, safety failures (must be 0).

## References

- ADR 018 — Discord idea tracking
- ADR 019 — Gated Discord tracking alerts
- ADR 021 — Tracking chain constraint + watch quality gate
- ADR 010 — Discord research isolation
- INV-D3–D8 in [INVARIANTS.md](../INVARIANTS.md)

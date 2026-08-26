---
title: "043 — Operator broadcast feedback"
status: accepted
date: 2026-08-10
last_verified: 2026-08-26
---

# ADR 043: Operator broadcast feedback

## Context

The bot delivers market broadcasts to Discord and Telegram. The operator reads
them and knows which ones help, but that judgement never reached the system.
The improvement harness learned only from sealed market outcomes, so copy
quality, subject choice, and timing had no feedback path at all.

## Decision

1. **Reaction intake.** The existing Discord Gateway bot listens for reactions
   on delivered broadcasts. Only `👍` and `👎`, only the configured broadcast
   channel, and only the user in `DISCORD_OPERATOR_USER_ID` count. Every other
   reaction is dropped with a typed reason (INV-B6).
2. **Provenance link.** The router writes `provider_message_index`, which maps
   each Discord message id to its delivery, event, and part. A reaction on any
   part of a split broadcast maps to one `feedbackId`.
3. **Durable ledger.** `~/.trenchcoat/broadcast-feedback/ledger.jsonl` is
   append-only. The newest line per `feedbackId` is the current record. Every
   write holds the feedback lock, because the listener and the chat can both
   write. A repeated reaction set is a no-op.
4. **Both marks are ambiguous.** `up` plus `down` records `ambiguous`, which
   needs detail like `down`. Removing every reaction records `retracted`.
5. **Telegram detail.** A `down` or `ambiguous` state queues one Telegram
   request. The operator answers in plain language. The host writes that text to
   one confined evidence file marked `untrusted-external`, and a classifier
   turns it into bounded tags plus one short derived summary. Raw prose never
   reaches the ledger, a prompt, or the harness (INV-B3, INV-S24). A request
   expires after 72 hours; the original reaction survives.
6. **Sealed datasets.** `broadcast feedback seal` builds one dataset from the
   ledger: preference pairs (one `up` and one detailed `down` of the same claim
   type and severity) and policy examples (market claims with archived
   decision-time signals). `accuracy` and `wrong-subject` corrections map to a
   safer verdict: `track` to `ignore`, `drop` to `revisit`. Narrative feedback
   and tone-only complaints stay out of decision policy.
7. **Manual, confined candidates.** `broadcast feedback candidate` proposes one
   change. It may write only two literal paths:
   `agent/skills/decision-policy/policy.json` and
   `config/broadcast-output-tuning.json`. Weight deltas cap at `0.25`,
   threshold deltas at `0.10`, and at most four rules change. A candidate must
   raise development preference agreement by at least `0.10`, keep holdout
   agreement, replay one unused market audit holdout, and keep every protected
   market metric. `broadcast feedback apply` needs a clean repository, takes
   `repo-mutation.lock`, and never commits, pushes, or deploys.
8. **Harness view.** The harness reads one sealed numeric file,
   `sealed/active-preference-set.json`, and rejects a later candidate that
   reduces agreement (`operator-preference-regression`). `src/harness` never
   imports the live feedback store; static lint enforces this.
9. **Prompt use.** Live 👍/👎 records (within `history_days`) load delivered
   broadcast text from the router database and enter the host worthiness gate as
   bounded liked/disliked examples. `up` leans approve; `down` and `ambiguous`
   lean reject; `retracted` and no reaction are excluded. Approved guidance in
   `config/broadcast-output-tuning.json` from manual apply still enters
   worthiness, topic distillation, and eligible agent job prompts as short
   bounded lines.

## Consequences

- The operator tunes outputs with two clicks and one sentence.
- Every tuning change stays manual, reviewable, and inside two files.
- Market safety keeps priority: no preference change bypasses the audit gates.
- Feedback text stays quarantined, so scraped or pasted prose cannot steer code.

## Related

- [ADR 039](039-bounded-improver-config-lane.md)
- [ADR 041](041-unified-broadcast-fanout.md)
- [docs/architecture/broadcast-feedback.md](../architecture/broadcast-feedback.md)
- `INV-B3`, `INV-B6`, `INV-S24`

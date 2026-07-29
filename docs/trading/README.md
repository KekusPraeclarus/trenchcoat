---
description: Context map for the planned autonomous trading pipeline (paper → dollar → bankroll). Design is settled; NO CODE EXISTS YET.
scope: project
status: planned
last_verified: 2026-07-29
---

# Trading pipeline — design docs

> **⚠️ STATUS: NOT STARTED — design only.**
> Nothing under `src/trading/`, no `trade-*` jobs, no `agent/state/trading/`
> exists yet. If you are working on another module and see references to the
> trading pipeline in these docs, they describe a **future** system. Do not
> assume any of its state files, jobs, contracts, or invariants are present.
>
> **When development starts:** flip `status` above to `in-progress` and note
> the branch/worktree here.
> **When live:** flip to `active`, record the go-live date here, move the
> module summary into `docs/architecture/README.md`'s index, and register the
> new invariants in `docs/INVARIANTS.md`.

## What this is

An autonomous trading system that finds, plans, and (initially on paper)
executes trades on Solana + major-EVM memecoins, modelled on the Tendy
"Solana Memecoin Playbook" framework (distilled in [playbook.md](playbook.md)).
Its purpose is different from every existing paper book in trenchcoat:

- The existing wallet / Fomo copy-trade books **grade other traders**.
- This pipeline grades **our own decisions**, and is the system we intend to
  put real capital through once it has climbed the promotion ladder:
  **paper → dollar ($1 max risk per trade) → 1% bankroll baseline**.

The agent sets and tunes deterministic trading rules; a forward-only gauntlet
promotes them; the self-improvement harness gets a full audit trail from trade
one.

## The one boundary rule

**Isolated mechanics, shared promoted intelligence.** This pipeline shares no
state, no scoring, and no ledgers with the Fomo/wallet trader-grading systems.
It consumes only one-way, snapshot-only, lagged *projections*:

- **Smart Money Context** — membership/tier of already-promoted wallets and
  Fomo traders (never raw feeds, scores, or unsettled outcomes)
- **Sentiment bucket** — gauge-token basket (main watchlist `tracking`
  tokens), narrative outputs, CoinGecko Trending, Fomo Trending (aggregate
  surface only, no account-level data)

Nothing in this pipeline ever writes back into watchlist, wallet, Fomo,
narrative, or source state. Full contract in [design.md](design.md).

## Reading order

1. [playbook.md](playbook.md) — the source trading framework and what the
   reference charts teach (why memecoin charts need special handling);
   visuals under [references/](references/README.md)
2. [design.md](design.md) — boundaries, pipeline, candidate universe,
   sentiment bucket, Smart Money Context contract, chains, proposed
   state/jobs, invariant candidates
3. [setups.md](setups.md) — lifecycle classifier, chart-quality gate,
   the v1 setup taxonomy and its deterministic features
4. [execution-and-risk.md](execution-and-risk.md) — trade-plan contract,
   paper fill simulation, sizing, portfolio risk, safety exits
5. [promotion-and-tuning.md](promotion-and-tuning.md) — policy versioning,
   the tuning gauntlet, capital-phase promotion gates, the smart-money v1
   decision
6. [data-and-providers.md](data-and-providers.md) — provider requirements per
   chain and the open questions to resolve before building

## Decisions already settled (do not re-litigate without the operator)

| Decision | Answer |
|---|---|
| Backtest vs live paper | **Live paper first** — stream everything, freeze at decision time, no historical reconstruction |
| v1 chain | Solana only; Base + Robinhood next; expand with rotations |
| v1 universe floor | ≥ $1M market cap (article default); lower-cap band later as a separate shadow experiment |
| Scanner shape | ~150 candidates/day as several fresh bounded batches (default 6 × 25), not one daily scrape |
| v1 setups | First fib retracement, respected trendline bounce, order-zone revisit — Lifecycle B only |
| Exits | Deterministic rules; agent proposes/tunes them; plans immutable once armed |
| Sizing model | Risk-at-invalidation (`notional = allowed loss / entry-to-invalidation distance`), capped by liquidity/notional/exposure |
| Smart Money Context at launch | **In v1 as recorded-on-every-plan shadow metadata** (audit trail from trade one); zero policy influence until base setups have enough mature trades for clean attribution |
| Live execution (later) | Airgapped executor on a separate VPS behind an IP-gated API; decision box never holds keys; requires a new ADR revisiting INV-A1 before the dollar phase |

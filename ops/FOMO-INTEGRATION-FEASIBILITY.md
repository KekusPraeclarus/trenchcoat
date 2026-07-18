## TLDR

Fomo itself has **no official public API** — it's a consumer trading app (mobile + [web](https://fomo.family/blog/announcing-fomo-web/)), and it deliberately hides trader wallet addresses in-product. So there is no direct, supported integration. But integration is still feasible **indirectly**, and the highest-value use maps almost perfectly onto infrastructure you already have: Fomo as a **smart-wallet discovery source** feeding your existing wallet scoring pipeline, where your own Helius/Infura providers remain the source of truth.

## What exists to integrate with

1. **No official API.** FOMO Labs exposes nothing developer-facing ([Quicknode's builder page](https://www.quicknode.com/builders-guide/tools/fomo-by-fomo-labs) confirms it's a consumer app). Scraping fomo.family web would require an authenticated account session, is ToS-risky, and brittle — same class of problem as your X scraping but with less payoff.

2. **A third-party API: [cope.capital](https://clawhub.ai/pooowell/fomo-research).** It reverse-maps Fomo handles to their on-chain wallets (Solana + Base) and exposes exactly the things you'd want: `/v1/leaderboard` (top traders by real PnL), `/v1/traders/search` (filter by win rate/PnL), `/v1/convergence` (2+ elite wallets buying the same token), `/v1/tokens/hot`, per-handle positions and activity. Free tier: 250 counted calls/day, 10 req/min. **Caveat that matters:** when I probed it just now, `api.cope.capital` returned 502 on both `/docs` and `/v1/leaderboard`. It's an unofficial dependency with unknown reliability — treat it like you treat the Robinhood public RPC: fail-closed, never load-bearing.

3. **Manual wallet extraction** is a known community technique ([RayBot's guide](https://docs.raybot.app/start/getting-started/use-cases/how-to-find-fomo-wallets.md)): match a Fomo profile's rounded cash balance against Solscan USDC holder lists, then trace Relay bridge transactions to find the paired EVM wallet. Tedious, but it works with zero API dependency — and it feeds your existing `tc wallets seed` path today with no code change at all.

## Where it benefits you most

**Ranked by value against your architecture:**

1. **Smart-wallet seeding and discovery (highest value, lowest change).** Your wallet pipeline (ADR 002) already has the hard part built: deterministic scoring from finalized on-chain outcomes, hysteresis, hard exclusions, lifecycle events. Its cold-start and discovery surface is the weak point — `wallet-discovery` only walks early buyers of tokens already on your watchlist. Fomo's leaderboard is a pre-curated set of provably profitable trencher wallets, exactly the population you want. Crucially, once a wallet ID is in `wallets.json`, **your own RPC providers own the truth** — Fomo/Cope only nominate candidates, your scans and scoring decide who survives. If Cope dies tomorrow, nothing degrades. This works immediately via the operator seed (`tc wallets seed`, `reasonCode: operator-seed`) with no code, or later as a periodic host collector staging `candidate` wallets.

2. **Convergence events as research-queue triggers.** "3 high-win-rate wallets bought the same mint within an hour" is a strong, on-chain-grounded discovery signal — arguably cleaner than shill-heavy Telegram alpha. It would enter as a new host collector under `src/collectors/`, writing `trust: "untrusted-external"` snapshots (INV-P1) and enqueueing into the research queue with a `social`-style trigger, where the existing security gate and resolution pipeline take over. Same for `/v1/tokens/hot` as a market-blind popularity input.

3. **Trader theses as sentiment evidence (marginal).** Fomo thesis text is attacker-controlled social content; your data-trust boundary already handles that class, but it adds little over what X/Farcaster/Telegram already give you.

**What is *not* on the table:** trade execution through Fomo. There's no API for it, and it would breach INV-A1 (advisory-only, no signing paths) — a hard invariant, not a preference.

## Constraints any implementation must respect

- All Cope calls go through the shared rate-limit gate (INV-R1), the `COPE_API_KEY` stays host-only and out of `agent/` (INV-I3), and Fomo-derived text reaches the agent only in untrusted snapshot envelopes (INV-P1).
- Never enable Cope's x402 mode — it authorizes real USDC payments per call. Free tier only.
- Fail-closed on Cope 5xx/402 (I already observed 502s), and never let a Cope-sourced signal write `sources.json`, wallet scores, or the watchlist directly — nomination only, consistent with INV-S19/S12.

## Recommendation

Cheapest validation first: manually extract 5–10 top Fomo leaderboard wallets and seed them via the existing `tc wallets seed` — zero code, and within a couple of review cycles your own scoring tells you whether Fomo-sourced wallets actually carry alpha. If they do, build the small Cope collector (leaderboard sync + convergence → research queue) behind a config flag, with a knowledge file at `docs/knowledge/cope-capital.md` documenting the unofficial-dependency risk. If they don't, you've spent an afternoon, not a module.

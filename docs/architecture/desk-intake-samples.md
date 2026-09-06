---
description: Sample trench.intake.v1 tickets for the desk pull-queue.
scope: architecture
status: active
last_verified: 2026-09-06
---

# Desk intake samples

These objects match `trench.intake.v1`. The host writes one line per ticket.
The desk script must not re-classify when `desk_ready` is true.

## Macro

```json
{
  "schema": "trench.intake.v1",
  "id": "11111111-1111-4111-8111-111111111111",
  "ts": "2026-09-06T18:00:00.000Z",
  "source": "narrative-agent",
  "channel": "telegram",
  "text": "Fed pause talk is the only bid. Treat this as macro colour.",
  "desk_ready": true,
  "class": "macro",
  "class_hint": "macro",
  "tickers": [],
  "thesis": "Fed pause talk is the only bid.",
  "chain_hint": null,
  "catalysts": [],
  "next": "desk_log",
  "drop_reason": null,
  "links": { "chart": null, "twitter": null, "telegram": null },
  "hints": { "liq_usd": null, "age_min": null, "mint": null },
  "urgency": "low",
  "trade_intent": "none"
}
```

## Flow basket

```json
{
  "schema": "trench.intake.v1",
  "id": "22222222-2222-4222-8222-222222222222",
  "ts": "2026-09-06T18:05:00.000Z",
  "source": "narrative-agent",
  "channel": "telegram",
  "text": "STAX leads the AI flow basket. Thin names chop.",
  "desk_ready": true,
  "class": "flow",
  "class_hint": "flow",
  "tickers": [
    { "symbol": "STAX", "stance": "flow" },
    { "symbol": "NPCS", "stance": "chop" }
  ],
  "thesis": "STAX leads the AI flow basket.",
  "chain_hint": "solana",
  "catalysts": [],
  "next": "resolver",
  "drop_reason": null,
  "links": { "chart": null, "twitter": null, "telegram": null },
  "hints": { "liq_usd": null, "age_min": null, "mint": null },
  "urgency": "med",
  "trade_intent": "watch"
}
```

## Catalyst

```json
{
  "schema": "trench.intake.v1",
  "id": "33333333-3333-4333-8333-333333333333",
  "ts": "2026-09-06T18:10:00.000Z",
  "source": "narrative-agent",
  "channel": "telegram",
  "text": "PONS lists on the Robinhood pad. Watch the first session only.",
  "desk_ready": true,
  "class": "catalyst",
  "class_hint": "catalyst",
  "tickers": [
    { "symbol": "PONS", "stance": "flow" }
  ],
  "thesis": "PONS lists on the Robinhood pad.",
  "chain_hint": "robinhood",
  "catalysts": ["listing"],
  "next": "resolver",
  "drop_reason": null,
  "links": { "chart": null, "twitter": null, "telegram": null },
  "hints": { "liq_usd": null, "age_min": null, "mint": null },
  "urgency": "high",
  "trade_intent": "consider"
}
```

## Noise

```json
{
  "schema": "trench.intake.v1",
  "id": "44444444-4444-4444-8444-444444444444",
  "ts": "2026-09-06T18:15:00.000Z",
  "source": "narrative-agent",
  "channel": "telegram",
  "text": "The meme lane faded. This is colour only.",
  "desk_ready": true,
  "class": "noise",
  "class_hint": "noise",
  "tickers": [],
  "thesis": "The meme lane faded.",
  "chain_hint": null,
  "catalysts": [],
  "next": "ignore",
  "drop_reason": "noise-class",
  "links": { "chart": null, "twitter": null, "telegram": null },
  "hints": { "liq_usd": null, "age_min": null, "mint": null },
  "urgency": "low",
  "trade_intent": "none"
}
```

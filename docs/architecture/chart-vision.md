---
description: Deterministic offline chart rendering from archived OHLCV plus model vision interpretation with separate audit.
scope: project
status: active
last_verified: 2026-08-31
last_edited: 2026-08-31
read_when:
  - Editing chart renderers, chart-sweep skill, or vision audit slices
---

# Chart vision

Charts are host-rendered offline from content-addressed OHLCV blobs. No network
assets, no remote fonts, no live price fetches inside the renderer.

## Pipeline

1. Collect closed candles into a market blob (`sha256` of canonical JSON).
2. Render deterministic SVG → PNG from that blob and a fixed feature-spec version.
3. Write a chart manifest: image path/hash, candle hash, timeframe, pair,
   feature version, bar cutoff.
4. Chart-sweep skill reads the image plus deterministic indicators. Vision output
   is interpretive evidence only.
5. PNG timeframe may be **1h** (preferred) or **15m** when 1h aggregation is too
   gappy; both use closed bars from the archived blob only — never invented prices.
6. Audit treats vision claims as a separate slice; promotion never depends on
   vision alone.

## Invariants

- Renderer input is an archived blob hash, never a live API response
- Golden-image/hash tests pin visual determinism for a fixture series
- Malformed/partial candle series fail closed (no chart, no vision call)
- Agent prompts reference manifest paths; they never embed candle arrays or
  scraped social text

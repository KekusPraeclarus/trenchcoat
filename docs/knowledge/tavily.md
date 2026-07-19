---
description: Provider knowledge — Tavily Search for host-mediated research web search.
scope: project
status: active
last_verified: 2026-07-19
---

# Tavily

- Replaced Brave Search as the sole host-mediated research web provider
- Collector: `src/collectors/web/tavily.ts`
- Agent writes validated queries to `web-search-requests.json`; host POSTs to
  `https://api.tavily.com/search` — never model-selected URLs
- Env: `TAVILY_API_KEY` in `~/.trenchcoat/env` (Bearer); scrubbed from Cursor
  child env (INV-I3). Without the key, research skips web search quietly
- Free tier: 1,000 credits/month, no card; `search_depth=basic` costs 1 credit —
  enough at `research.web_search.max_queries_per_run` ≤ 3
- Keep `include_answer` / `include_raw_content` / `include_images` off — hits only
  as `untrusted-external` inbox snapshots (`source: tavily.web`)
- Docs: https://docs.tavily.com/documentation/api-reference/endpoint/search
  (verified 2026-07-18 against API reference)

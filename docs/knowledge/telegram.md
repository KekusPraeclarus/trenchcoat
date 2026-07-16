---
description: Provider knowledge — Telegram preview and GramJS listener.
scope: project
status: active
---

# Telegram

- Preview mode via `t.me/s` fixtures/parsers
- GramJS for consented channels only; consentRef required in config
- FLOOD_WAIT backoff; atomic finalized message writes; heartbeat + cursor
- Operator chat bot is separate from router fanout bot
- Chat replies allowlist-checked before any handling (INV-B3)

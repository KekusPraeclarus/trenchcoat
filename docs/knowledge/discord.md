---
description: Provider knowledge — Discord webhook fanout from the router.
scope: project
status: active
---

# Discord

- Router-only webhook delivery with `wait=true`
- `allowed_mentions.parse=[]` always
- At-least-once; ambiguous timeouts may duplicate
- Dedicated E2E webhook distinct from production

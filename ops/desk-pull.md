---
description: Public HTTPS front for the desk pull-queue. Loopback :8788 stays private.
scope: ops
status: active
last_verified: 2026-09-06
---

# Desk pull HTTPS front

The router serves the pull-queue on loopback `127.0.0.1:8788`. Do not open
`:8787` or `:8788` on the public firewall. Put TLS in front. Expose only
`/desk/intake/*`.

## Env on the VPS

Write these keys in `~/.trenchcoat/env`. Never commit them.

```bash
openssl rand -hex 32
```

| Key | Use |
|---|---|
| `DESK_PULL_TOKEN` | Bearer secret. Length must be 24 or more |
| `DESK_PULL_HOST` | Default `127.0.0.1` |
| `DESK_PULL_PORT` | Default `8788` |
| `DESK_PULL_LOG` | Default `~/.trenchcoat/desk-intake/desk_tickets.jsonl` |

Restart `trenchcoat-router` after a write. Give the token to KP out of band.

## Caddy snippet

Replace `DESK_PULL_PUBLIC_HOST` with the DNS name.

```caddy
{$DESK_PULL_PUBLIC_HOST} {
  @desk path /desk/intake/*
  reverse_proxy @desk 127.0.0.1:8788
  respond 404
}
```

Open 443 only. Keep 8787 and 8788 on loopback.

## Poll interval

The desk should poll every 60 to 120 seconds. Do not poll faster.

## curl dry-run

Use env vars only. Do not put the token in shell history.

```bash
curl -sS "$DESK_PULL_BASE_URL/desk/intake/pending?limit=50" \
  -H "Authorization: Bearer $DESK_PULL_TOKEN"

curl -sS "$DESK_PULL_BASE_URL/desk/intake/pending?since_id=$LAST_ID&limit=50" \
  -H "Authorization: Bearer $DESK_PULL_TOKEN"

curl -sS -X POST "$DESK_PULL_BASE_URL/desk/intake/ack" \
  -H "Authorization: Bearer $DESK_PULL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ids":["11111111-1111-4111-8111-111111111111"]}'
```

A wrong token must return 401 with no tickets.

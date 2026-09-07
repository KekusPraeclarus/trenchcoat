---
description: Public HTTPS front for the desk pull-queue. Loopback :8788 stays private.
scope: ops
status: active
last_verified: 2026-09-07
---

# Desk pull HTTPS front

The router serves the pull-queue on loopback `127.0.0.1:8788`. Do not open
`:8787` or `:8788` on the public firewall. Put TLS in front. Expose only
`/desk/intake/*`.

## Bind and firewall (hard)

UFW 80 and 443 exist only for Caddy. They are not a general web port.

- Do not bind trenchcoat, the router, or any other app to 80 or 443.
- Only Caddy may listen on `0.0.0.0:80` and `0.0.0.0:443`.
- Caddy may reverse-proxy `/desk/intake/*` to `127.0.0.1:8788` only.
- Do not proxy `:8787`. Do not proxy `/healthz`. Do not proxy `/v1/events`.
- Do not UFW-allow 80 or 443 until that Caddyfile is loaded.
- If those rules are open with no Caddy, delete them. Open them again with Caddy.
- Do not install Apache, nginx, Cockpit, or another stack that binds 80 or 443.

Check after any install:

```bash
ss -lnt | awk 'NR==1 || $4 ~ /:80$|:443$|:8787$|:8788$/'
```

Expect 80 and 443 on Caddy only. Expect 8787 and 8788 on `127.0.0.1` only.

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
  handle /desk/intake/* {
    reverse_proxy 127.0.0.1:8788
  }
  handle {
    respond 404
  }
}
```

Open 80 and 443 only when Caddy is ready. Keep 8787 and 8788 on loopback.

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

## Silence checklist

A missing `INTAKE_*` key skips the Grok webhook only. The pull-queue still
appends. A direct webhook curl is not a router fanout.

Check `DESK_PULL_TOKEN` in `~/.trenchcoat/env`. Check `127.0.0.1:8788/healthz`.
Check Caddy for `/desk/intake/*` only. Do not look for a `grok` destination
row unless you also set both `INTAKE_*` keys.

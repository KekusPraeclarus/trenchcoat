---
description: Provider knowledge — Cursor CLI local agent (login auth, not API key).
scope: project
status: active
---

# Cursor CLI

Install: [cursor.com/docs/cli/installation](https://cursor.com/docs/cli/installation)

```bash
curl https://cursor.com/install -fsS | bash
agent login
agent status   # must show Logged in
```

## trenchcoat harness

- Binary: `agent` (or `cursor-agent`) from `~/.local/bin`
- Headless: `agent -p --trust --sandbox enabled --workspace <agent/> --model composer-2.5`
- Auth: operator CLI login — **not** `CURSOR_API_KEY` (optional override only)
- Jobs are one-shot; chat may use `--resume <chatId>`
- Never interpolate scraped text into the prompt — path references only
- Outer Linux container still mounts only `agent/`; CLI sandbox alone does not satisfy INV-I1

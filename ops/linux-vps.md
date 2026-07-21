---
description: Blank Linux VPS bootstrap for trenchcoat — SSH, packages, migrate, systemd install, Actions deploy.
scope: ops
status: active
last_verified: 2026-07-21
read_when:
  - Standing up a Linux host (not macOS launchd)
  - Wiring GitHub Actions auto-deploy
---

# Linux VPS bootstrap

macOS production path remains `ops/install-launchd.sh`. On Linux use this doc +
`ops/install-systemd.sh` + `ops/trenchcoat-deploy.sh`.

Assume: SSH hardened, user `trenchcoat`, key-only login, UFW allowing SSH only,
GitHub secrets `VPS_HOST` / `VPS_USER` / `VPS_SSH_KEY` already set. **No repo and
no `~/bin/trenchcoat-deploy` on the VPS yet** — do the steps below in order.

## Order (do not skip)

| Step | What | Gate |
|---|---|---|
| A | Packages + Node + pnpm + Cursor login | `node -v`, `agent status` |
| B | Clone repo (deploy key) | `~/src/trenchcoat/.git` |
| C | Linger for user systemd | `loginctl show-user trenchcoat \| grep Linger=yes` |
| D | Stop Mac jobs → rsync `~/.trenchcoat/` | `config.json` + `env` on VPS |
| E | First `ops/install-systemd.sh` | KeepAlives up, `tc status` |
| F | Push workflow + Linux scripts to `main` | Actions Deploy VPS green |

Actions before step E will fail with “deploy entrypoint missing” — expected.

## A — Packages

As `trenchcoat` (sudo where noted):

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential git curl ca-certificates python3 \
  pkg-config libsqlite3-dev rsync \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 libcairo2

curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable
# Pin to repo packageManager (avoid pnpm 11 "latest" until allowBuilds is settled)
corepack prepare pnpm@10.18.3 --activate

curl https://cursor.com/install -fsS | bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
agent login
agent status
```

## B — Clone with read deploy key

```bash
ssh-keygen -t ed25519 -f ~/.ssh/trenchcoat_deploy -C "trenchcoat-deploy" -N ""
cat ~/.ssh/trenchcoat_deploy.pub
# GitHub → repo Settings → Deploy keys → Add (read-only unless chain-integration must push)

cat >> ~/.ssh/config <<'EOF'
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/trenchcoat_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config

mkdir -p ~/src
git clone git@github.com:AbstractLogica/trenchcoat.git ~/src/trenchcoat
cd ~/src/trenchcoat
pnpm install
```

Until the Linux install commit is on `main`, either push it from the Mac first or
`git fetch` after that push before step E.

## C — User systemd linger

```bash
sudo loginctl enable-linger trenchcoat
# confirm
loginctl show-user trenchcoat | grep Linger
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user status >/dev/null && echo user-bus-ok
```

Linger lets timers/KeepAlives run without an interactive login (required for
Actions SSH deploys).

## D — Migrate host state (Mac → VPS)

On the **Mac**, stop trenchcoat launchd units so profiles/SQLite are quiet, then:

```bash
# macOS stock rsync: use --progress (not --info=progress2)
rsync -aH --progress \
  --exclude 'runtime/' \
  --exclude 'runtime.prev/' \
  --exclude 'bin/' \
  --exclude '.DS_Store' \
  ~/.trenchcoat/ \
  "$TRENCHCOAT_SSH_HOST:~/.trenchcoat/"
```

On the **VPS**:

```bash
chmod 700 ~/.trenchcoat
chmod 600 ~/.trenchcoat/env ~/.trenchcoat/config.json

# Fix Linux paths inside env (edit):
#   TRENCHCOAT_REPO_ROOT=/home/trenchcoat/src/trenchcoat
#   TRENCHCOAT_CURSOR_BIN=/home/trenchcoat/.local/bin/agent   # if needed
```

Do **not** copy Mac `runtime/` — Linux rebuilds native `better-sqlite3`.

Unload Mac launchd after cutover so Telegram/Discord are not double-connected.

## E — First install

If `pnpm build` fails with `ERR_PNPM_IGNORED_BUILDS`, you are on pnpm 11
without allowBuilds — pin with `corepack prepare pnpm@10.18.3 --activate`
or pull a commit that includes `pnpm-workspace.yaml`, then
`rm -rf node_modules && pnpm install`.

```bash
cd ~/src/trenchcoat
git pull --ff-only origin main
git status --porcelain
./ops/install-systemd.sh --skip-agent-wait

export PATH="$HOME/.trenchcoat/bin:$HOME/.local/bin:$PATH"
tc status
curl -sS http://127.0.0.1:8787/healthz
systemctl --user list-timers 'trenchcoat-*'
systemctl --user status trenchcoat-router trenchcoat-listener trenchcoat-channels trenchcoat-x-scan
```

Installer writes `~/bin/trenchcoat-deploy` → `~/.trenchcoat/bin/trenchcoat-deploy`.

Optional: lock the Actions SSH key to that entrypoint only (same line in
`authorized_keys`):

```text
command="/home/trenchcoat/bin/trenchcoat-deploy",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA... github-actions-deploy
```

## F — Auto-deploy on push

With secrets set and `.github/workflows/deploy-vps.yml` on `main`:

1. Push to `main` from the Mac (or **Actions → Deploy VPS → Run workflow**)
2. Job SSHs in and runs `~/bin/trenchcoat-deploy` (ff-only `git pull` +
   `ops/install-systemd.sh`)
3. Confirm the Action is green and `tc status` shows the new commit in
   deployment provenance

## Ops cheat sheet

| Task | Command |
|---|---|
| Manual deploy | `~/bin/trenchcoat-deploy` |
| Logs | `/tmp/trenchcoat.*.log` |
| Restart KeepAlive | `systemctl --user restart trenchcoat-router` (etc.) |
| Timers | `systemctl --user list-timers 'trenchcoat-*'` |
| Rollback runtime | `mv ~/.trenchcoat/runtime ~/.trenchcoat/runtime.bad && mv ~/.trenchcoat/runtime.prev ~/.trenchcoat/runtime && systemctl --user restart trenchcoat-router trenchcoat-listener trenchcoat-channels trenchcoat-x-scan` |

## Auth after migrate

- Cursor: already logged in on VPS (step A) — does not travel with rsync
- X / Fomo Playwright profiles: try rsynced state; on challenge run
  `tc auth twitter` / `tc auth fomo` (headed — use provider VNC/console if needed)
- GramJS session: rsync `telegram-session/` if present

## Security reminders

- Router stays on loopback (`127.0.0.1:8787`) — do not UFW-allow it
- Never commit `~/.trenchcoat/env` or browser profiles
- Separate desktop SSH key, Actions SSH key, and GitHub deploy key
- Desktop initiates only (SSH out, `git push`); VPS never SSHs to the Mac

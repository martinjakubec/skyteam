# Production variables

Production secrets and settings live in GitHub, under the repo's Settings →
Secrets and variables → Actions:

- **secrets** for anything that must stay hidden;
- **variables** for plain settings.

The copy the server runs with is the `.env` beside `docker-compose.yml`. It is
git-ignored and must never be committed. Keep this list current whenever a new
setting is added.

## Set these for production

| Name | GitHub | Required | Production value | Status |
|---|---|---|---|---|
| `JWT_SECRET` | secret | yes | 64 hex characters (`openssl rand -hex 32`). Anyone who has it can take over any seat. The server refuses to start with a placeholder or anything under 32 characters. | generated into local `.env` 2026-10-07 · ☐ in GitHub |
| `POSTGRES_PASSWORD` | secret | yes | 48 hex characters (`openssl rand -hex 24`). Hex, so it fits in `DATABASE_URL` unescaped. Compose refuses to start without it. | generated into local `.env` 2026-10-07 · ☐ in GitHub |
| `SESSION_SECRET` | secret | yes | 64 hex characters (`openssl rand -hex 32`), different from `JWT_SECRET`. Signs sign-in sessions; anyone who has it can sign in as anyone. The server refuses to start with a placeholder, anything under 32 characters, or a copy of `JWT_SECRET`. | generated into local `.env` 2026-10-08 · ☐ in GitHub |
| `SUPERADMIN_USERNAME` | variable | recommended | The site owner's username (3–24 of `a-z 0-9 . _ -`). On start, the server creates this account as SUPERADMIN if it doesn't exist, or makes it SUPERADMIN again if it does. Nobody can register this name. | local `.env`: `admin` · ☐ |
| `SUPERADMIN_INITIAL_PASSWORD` | secret | with `SUPERADMIN_USERNAME` | The owner account's first password, at least 10 characters in production (`openssl rand -base64 18`). Used only when the account is created; sign in and change it right away. | local `.env`: `admin` (dev only) · ☐ in GitHub |
| `CLIENT_ORIGIN` | variable | yes | The site's public origin, e.g. `https://skyteam.example`. A comma-separated list is allowed. `*` is refused in production. | ☐ |
| `VITE_SERVER_URL` | variable | yes | The server's public URL as browsers reach it, e.g. `https://skyteam.example` behind the proxy. It is built into the client at build time, so rebuild the client after changing it. | ☐ |
| `TRUST_PROXY` | variable | behind a proxy | `2` behind Caddy plus the client's nginx (the VPS plan), so rate limits see real client addresses. Too high a number lets clients fake their address. | ☐ |
| `NPC_WORKERS` | variable | recommended | The CPUs the server may use for the bot's search, e.g. `1` on a 2-vCPU VPS. Unset, it counts the host's cores, which can exceed the container's limit. | ☐ |
| `GIT_SHA` | set by the deploy | recommended | `$(git rev-parse --short HEAD)` at deploy time. It is stamped on every logged game. Unset, it is `dev`. | ☐ |
| `RECONNECT_GRACE_MS` | variable | no | How long a dropped player's seat is held. The default, `60000` (60 s), is fine. | default |

## Don't set these

- **`DATABASE_URL`, `REDIS_URL`, `PORT`:** `docker-compose.yml` builds them from
  the values above.
- **`REAL_TIME_SECONDS`, `DEBRIEF_COUNTDOWN_MS`, `NPC_DELAY_MS`, `NPC_THINK_MS`:**
  test and tuning knobs. In production they would shorten Real-Time rounds or
  the countdown between rounds, or change how the bot plays.
- **`VITE_SERVER_PORT`:** only used when `VITE_SERVER_URL` is unset (dev and LAN).

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

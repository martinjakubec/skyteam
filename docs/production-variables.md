# Production variables

Production secrets and settings live in GitHub, in the repository's **Settings →
Environments → `production`**:

- **secrets** for anything that must stay hidden;
- **variables** for plain settings.

Each deploy writes them to the VPS: the app's settings go to
`/srv/apps/skyteam/.env`, and the site password's hash to
`/srv/edge/auth/skyteam.caddy`. Nothing secret is ever in the repository.

**Getting the values.** Your git-ignored `.env.production` holds a generated
value for each one, ready to copy. When adding a new setting, put it here, in
`.env.production`, and in the deploy workflow.

## Secrets

| Name | Required | Value | Status |
|---|---|---|---|
| `JWT_SECRET` | yes | 64 hex characters (`openssl rand -hex 32`). Signs the players' identity tokens: anyone who has it can take over any seat. The server refuses to start with a placeholder or anything under 32 characters. | in `.env.production` · ☐ in GitHub |
| `SESSION_SECRET` | yes | 64 hex characters, different from `JWT_SECRET`. Signs sign-in sessions: anyone who has it can sign in as anyone. | in `.env.production` · ☐ in GitHub |
| `POSTGRES_PASSWORD` | yes | 48 hex characters (`openssl rand -hex 24`). Hex, so it fits in the database URL unescaped. | in `.env.production` · ☐ in GitHub |
| `SUPERADMIN_INITIAL_PASSWORD` | with `SUPERADMIN_USERNAME` | The owner account's first password, at least 10 characters. Used only when the account is created: sign in and change it right away. | in `.env.production` · ☐ in GitHub |
| `SITE_USERNAME` | recommended | The username of the password gate in front of the whole site (letters, digits, `. _ -`). | in `.env.production` (`skyteam`) · ☐ in GitHub |
| `SITE_PASSWORD` | recommended | Its password. With either of the two unset, the site is open to everyone. | in `.env.production` · ☐ in GitHub |
| `DEPLOY_HOST` | yes | The VPS's IP address or host name. | ☐ |
| `DEPLOY_SSH_KEY` | yes | The private deploy key (`skyteam-deploy`, see [deployment.md](deployment.md)). | ☐ |
| `DEPLOY_KNOWN_HOSTS` | yes | The VPS's host keys: the output of `ssh-keyscan <vps-ip>`. | ☐ |
| `DEPLOY_USER` | no | The SSH user. Default `deploy`, which is what `bootstrap-vps.sh` creates. | default |

None of the values may contain a single quote (`'`). The workflow refuses them.

## Variables

| Name | Required | Value | Status |
|---|---|---|---|
| `SUPERADMIN_USERNAME` | recommended | The site owner's username. On start, the server creates this account as SUPERADMIN if it doesn't exist, or makes it SUPERADMIN again if it does. Nobody can register this name. | `.env.production`: `admin` · ☐ |
| `NPC_WORKERS` | recommended | The CPUs the bot's search may use: the VPS's vCPUs minus one, at least `1`. | `.env.production`: `1` · ☐ |
| `RECONNECT_GRACE_MS` | no | How long a dropped player's seat is held. The default, `60000` (60 s), is fine. | default |

## Set by the deployment itself

`deploy/app/compose.yml` and the workflow set these, so don't put them in GitHub:

| Name | Value |
|---|---|
| `CLIENT_ORIGIN` | `https://skyteam.mjakubec.eu` |
| `TRUST_PROXY` | `2`: Caddy, then the client's nginx |
| `DATABASE_URL`, `REDIS_URL`, `PORT` | the containers' own addresses |
| `GIT_SHA` / `IMAGE_TAG` | the deployed commit |

`VITE_SERVER_URL` isn't needed any more: a production build talks to its own
origin.

## Don't set these

- **`REAL_TIME_SECONDS`, `DEBRIEF_COUNTDOWN_MS`, `NPC_DELAY_MS`, `NPC_THINK_MS`:**
  test and tuning knobs. In production they would shorten Real-Time rounds or
  the countdown between rounds, or change how the bot plays.
- **`VITE_SERVER_PORT`:** only used in development.

## Locally

The git-ignored `.env` holds the values `docker-compose.yml` and
`docker-compose.dev.yml` use on your machine, including the local owner account
admin / admin. Production never uses it.

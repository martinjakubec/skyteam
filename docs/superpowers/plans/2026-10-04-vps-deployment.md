# VPS Deployment Implementation Plan

> **Status:** Parked until the MVP is done. Pick this up afterwards.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks marked **(VPS)** or **(GitHub UI)** are done by the user by hand; guide them through those steps, don't attempt them yourself.

**Goal:** SkyTeam runs at `https://skyteam.mjakubec.eu` on a fresh OVH VPS, deployed by GitHub Actions on every push to `main`. The same VPS can host more apps later, on subdomains (`app.mjakubec.eu`) or under paths (`mjakubec.eu/app`).

**Architecture:**

```
Internet ─► Caddy (80/443, Docker network "edge")
              ├─ skyteam.mjakubec.eu ─► skyteam-web:80 (client nginx) ─► server:3001 ─► redis
              └─ mjakubec.eu/other/* ─► other-web:80
```

- **Edge proxy:** a single Caddy container owns ports 80/443 and gets and renews Let's Encrypt certificates on its own. Each app gets one site file under `/srv/edge/sites/`. We picked Caddy over nginx at the edge so there's no certbot, no renewal cron and no manual WebSocket config.
- **Apps:** each app is its own compose project in `/srv/apps/<app>/`. Only the app's entry container joins the external `edge` network, under a unique alias (`skyteam-web`). Everything else (`server`, `redis`) stays on the app's private default network, so service names never clash between apps.
- **Same-origin API:** in production the browser talks to its own origin. SkyTeam's client nginx forwards `/rooms`, `/identity`, `/health`, `/api` and `/socket.io/` to `server:3001`, so CORS doesn't come into play and the edge needs one upstream per app.
- **Images:** GitHub Actions builds and pushes `ghcr.io/martinjakubec/skyteam-{server,client}:{<sha>,latest}`. The VPS only pulls; it never builds.
- **Secrets:** `JWT_SECRET` lives only in `/srv/apps/skyteam/.env` on the VPS. GitHub holds only the SSH deploy credentials.

**Tech Stack:** Docker Compose, Caddy 2, nginx (inside the client image), GitHub Actions, GHCR, Ubuntu on OVH.

## Global Constraints

- **No app port is ever published on the host.** Only Caddy publishes 80/443. Docker-published ports skip `ufw`, so the current `docker-compose.yml` (which publishes Redis on 6379) must never run on the VPS.
- Local development keeps working exactly as before: `docker-compose.dev.yml` and `docker-compose.yml` are unchanged, and `VITE_SERVER_URL` still wins when set.
- Subdomain, not a path: SkyTeam assumes it lives at `/` (invite link `${origin}/?join=`, Vite `base`, Socket.IO path).
- Every container uses `restart: unless-stopped`, and Docker is enabled in systemd, so the whole VPS comes back on its own after a reboot.

## Review Focus

1. **Startup order after a VPS reboot:** the Docker daemon ignores `depends_on`. The client's nginx must not crash-loop when `server` isn't resolvable yet. This is pinned in Task 2 (resolver + upstream held in a variable, resolved per request).
2. **WebSockets through two proxies** (Caddy → client nginx → server): an invite link opened in a second browser must connect and play. Pinned in Task 2 (Upgrade headers, 1h read timeout) and Task 9 (manual check).
3. **Redis never reachable from outside:** `ss -tlnp` on the VPS shows only 22, 80 and 443. Checked in Task 9.

---

## Task 1: Client uses its own origin in production

**Files:** `packages/client/src/config.ts`

- [ ] In `resolveServerUrl()`, right after the `VITE_SERVER_URL` override check, add:
  ```ts
  if (import.meta.env.PROD) return window.location.origin;
  ```
  Update the doc comment. Production builds now go through the page's own origin; dev still derives `:3001`.
- [ ] `npm run typecheck`

## Task 2: Client nginx forwards the API and WebSocket

**Files:** `packages/client/nginx.conf`

- [ ] Replace with the following, keeping the security headers (`server_tokens off`, the CSP and the other `add_header` lines) that the current `nginx.conf` sets at server level:
  ```nginx
  server {
    listen 80;
    server_name _;

    root /usr/share/nginx/html;
    index index.html;

    # Resolve the server per request (Docker DNS), so nginx starts even when the
    # server container isn't up yet, e.g. after a reboot, when depends_on is ignored.
    resolver 127.0.0.11 valid=10s ipv6=off;
    set $api http://server:3001;

    # Pass on the client's address (Caddy's X-Forwarded-For plus Caddy itself):
    # the server's rate limits key on it (TRUST_PROXY=2).
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    location ~ ^/(rooms|identity|health|api)(/|$) {
      proxy_pass $api;
    }

    location /socket.io/ {
      proxy_pass $api;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
      proxy_read_timeout 1h;
    }

    location /assets/ {
      expires 1y;
      add_header Cache-Control "public, immutable";
      # add_header here drops the server-level security headers: repeat them
      # (move them into a snippet and `include` it in both places).
    }

    # SPA fallback so deep links / invite links (/?join=...) always load index.html.
    location / {
      try_files $uri $uri/ /index.html;
    }
  }
  ```
- [ ] Check locally: `docker compose up --build` still works (it sets `VITE_SERVER_URL`, so the browser goes straight to `:3001`). Then build the client **without** `VITE_SERVER_URL` and confirm `http://localhost:8080/health` returns `{"ok":true}` through the client's nginx.

## Task 3: Production compose file

**Files:** `deploy/compose.prod.yml` (new)

- [ ] Create:
  ```yaml
  # Production stack, run on the VPS from /srv/apps/skyteam (copied there by CI).
  # Images come from GHCR; nothing is built here. Reads .env (JWT_SECRET, IMAGE_TAG).
  name: skyteam
  services:
    redis:
      image: redis:7-alpine
      restart: unless-stopped
      command: ["redis-server", "--appendonly", "yes"]
      volumes: [redis-data:/data]
      healthcheck:
        test: ["CMD", "redis-cli", "ping"]
        interval: 5s
        timeout: 3s
        retries: 5

    server:
      image: ghcr.io/martinjakubec/skyteam-server:${IMAGE_TAG:-latest}
      restart: unless-stopped
      env_file: .env
      environment:
        REDIS_URL: redis://redis:6379
        CLIENT_ORIGIN: https://skyteam.mjakubec.eu
        # Search threads for the bot: the VPS's vCPUs minus one (at least 1).
        NPC_WORKERS: ${NPC_WORKERS:-1}
        # Caddy, then the client's nginx: the rate limits read the client's
        # address two hops back in X-Forwarded-For.
        TRUST_PROXY: 2
      depends_on:
        redis:
          condition: service_healthy

    client:
      image: ghcr.io/martinjakubec/skyteam-client:${IMAGE_TAG:-latest}
      restart: unless-stopped
      depends_on: [server]
      networks:
        default: {}
        edge:
          aliases: [skyteam-web]

  networks:
    edge:
      external: true

  volumes:
    redis-data:
  ```
- [ ] Validate: `IMAGE_TAG=x JWT_SECRET=x docker compose -f deploy/compose.prod.yml config` (needs a dummy `deploy/.env`; don't commit it).

## Task 4: GitHub Actions workflow

**Files:** `.github/workflows/deploy.yml` (new)

- [ ] Create a workflow with:
  - Triggers: `push` to `main`, plus `workflow_dispatch`. Set `concurrency: { group: deploy-skyteam, cancel-in-progress: false }` and `permissions: { contents: read, packages: write }`.
  - **test:** `actions/checkout@v4`, `actions/setup-node@v4` (node 22, `cache: npm`), `npm ci`, `npm run typecheck`, `npm test`. If the bot tests take too long in CI, run only `test-rules` and `test-units` here.
  - **build** (`needs: test`): a matrix with `app: [server, client]`. Steps:
    - `docker/setup-buildx-action@v3`
    - `docker/login-action@v3` (registry `ghcr.io`, `${{ github.actor }}` / `${{ secrets.GITHUB_TOKEN }}`)
    - `docker/build-push-action@v6` with `context: .`, `file: packages/${{ matrix.app }}/Dockerfile`, `push: true`, tags `ghcr.io/martinjakubec/skyteam-${{ matrix.app }}:${{ github.sha }}` and `:latest`, `cache-from/to: type=gha,scope=${{ matrix.app }}` (`mode=max` on `to`).
    - Pass no `VITE_SERVER_URL`, so the build uses the same-origin behaviour from Task 1.
  - **deploy** (`needs: build`, `environment: production`):
    - Write `secrets.DEPLOY_SSH_KEY` to `~/.ssh/id_ed25519` (chmod 600) and `secrets.DEPLOY_KNOWN_HOSTS` to `~/.ssh/known_hosts`.
    - `scp deploy/compose.prod.yml $USER@$HOST:/srv/apps/skyteam/compose.yml`
    - Over SSH: `cd /srv/apps/skyteam && sed -i '/^IMAGE_TAG=/d' .env && echo "IMAGE_TAG=${{ github.sha }}" >> .env && docker compose pull && docker compose up -d --remove-orphans && docker image prune -f`
    - Smoke test: `curl -fsS --retry 10 --retry-delay 3 --retry-all-errors https://skyteam.mjakubec.eu/health`
- [ ] Rollback (document in the README): set an older SHA in `.env` as `IMAGE_TAG`, then run `docker compose up -d`.

## Task 5: DNS (OVH panel, user)

- [ ] A record `mjakubec.eu` → VPS IPv4; A record `*.mjakubec.eu` → VPS IPv4.
- [ ] Matching AAAA records if the VPS has IPv6.
- [ ] Check with `dig +short skyteam.mjakubec.eu`.

## Task 6: VPS base setup (VPS, user)

- [ ] As the default `ubuntu` user:
  ```bash
  sudo apt update && sudo apt upgrade -y
  curl -fsSL https://get.docker.com | sudo sh
  systemctl is-enabled docker          # must print "enabled", else: sudo systemctl enable docker containerd
  sudo adduser --disabled-password deploy && sudo usermod -aG docker deploy   # docker group ≈ root
  sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw allow 443/udp && sudo ufw enable
  docker network create edge
  sudo mkdir -p /srv/edge/sites /srv/apps/skyteam && sudo chown -R deploy: /srv
  ```
- [ ] In `/etc/ssh/sshd_config`, set `PasswordAuthentication no` and `PermitRootLogin no`, then `sudo systemctl restart ssh`. Check that key login still works **from a second terminal before closing the first.**

## Task 7: Edge proxy (VPS, user; later its own `infra` repo)

- [ ] `/srv/edge/compose.yml`:
  ```yaml
  services:
    caddy:
      image: caddy:2-alpine
      restart: unless-stopped
      ports: ["80:80", "443:443", "443:443/udp"]
      volumes:
        - ./Caddyfile:/etc/caddy/Caddyfile:ro
        - ./sites:/etc/caddy/sites:ro
        - caddy-data:/data
        - caddy-config:/config
      networks: [edge]
  networks:
    edge:
      external: true
  volumes:
    caddy-data:
    caddy-config:
  ```
- [ ] `/srv/edge/Caddyfile`:
  ```
  {
  	email <your email for Let's Encrypt notices>
  }
  import sites/*.caddy
  ```
- [ ] `/srv/edge/sites/skyteam.caddy`:
  ```
  skyteam.mjakubec.eu {
  	encode zstd gzip
  	reverse_proxy skyteam-web:80
  }
  ```
- [ ] `docker compose up -d`. A 502 is expected until SkyTeam is deployed. After editing a site file later, run `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`.

## Task 8: Secrets and access (VPS + GitHub UI, user)

- [ ] On the VPS, as `deploy`: `echo "JWT_SECRET=$(openssl rand -hex 32)" > /srv/apps/skyteam/.env && chmod 600 /srv/apps/skyteam/.env`. The server refuses to start in production without a real secret (32+ characters, not a placeholder).
- [ ] Check the vCPU count with `nproc`. If it's more than 2, append `NPC_WORKERS=<nproc − 1>` to the same `.env`.
- [ ] If the GHCR packages are private, run `docker login ghcr.io` as `deploy` with a classic PAT that has only the `read:packages` scope.
- [ ] Create a deploy key pair with `ssh-keygen -t ed25519 -f skyteam-deploy -N ""`. Append the `.pub` to `/home/deploy/.ssh/authorized_keys`.
- [ ] GitHub repo → Settings → Environments → `production`. Add these secrets:
  - `DEPLOY_HOST`
  - `DEPLOY_USER=deploy`
  - `DEPLOY_SSH_KEY` (the private key)
  - `DEPLOY_KNOWN_HOSTS` (output of `ssh-keyscan <vps-ip>`)

## Task 9: First deploy and verification

- [ ] Merge Tasks 1–4 to `main` and watch the Action finish.
- [ ] `curl https://skyteam.mjakubec.eu/health` returns `{"ok":true}`, and the certificate is valid.
- [ ] Create a room, open the invite link in a second browser, and play a round. The WebSocket must stay connected.
- [ ] Start a solo game against the Aviator bot. Watch `docker stats` for how long it thinks; a small VPS may need a lower `NPC_THINK_MS` or more vCPUs.
- [ ] On the VPS, `sudo ss -tlnp` lists only 22, 80 and 443. Redis and 3001 must not appear.
- [ ] Reboot test: `sudo reboot`, wait a minute, then `docker ps` shows every container up and `/health` answers. An open game resumes after the client reconnects.

## Later: adding another app

- **Subdomain:** add `sites/<app>.caddy` with `reverse_proxy <app>-web:80`, give the app's entry container the alias `<app>-web` on `edge`, and copy this workflow.
- **Path** (`mjakubec.eu/<app>`): inside a `mjakubec.eu { … }` site block, add `handle_path /<app>/* { reverse_proxy <app>-web:80 }`. The app itself must support the base path (Vite `base`, router base, API/WebSocket prefix); most of the work for a path-based app is there.

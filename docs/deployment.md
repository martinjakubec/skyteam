# Deployment: skyteam.mjakubec.eu

SkyTeam runs on a VPS, deployed by GitHub Actions whenever a release is
published. Pre-releases don't deploy. Pushing to `main` only runs the tests
(`.github/workflows/test.yml`).
Everything on the VPS is code in this repository; the VPS itself only needs
Docker:

| What | Where it's defined | Runs as |
|---|---|---|
| HTTPS, certificates, the site's username/password | `deploy/edge/` (Caddy) | container `edge-caddy-1` |
| The game: client (nginx), server, Redis, PostgreSQL, nightly backups | `deploy/app/compose.yml` | containers `skyteam-*` |
| Test on every push to `main` | `.github/workflows/test.yml` | GitHub Actions |
| Test, build, deploy a release | `.github/workflows/deploy.yml` | GitHub Actions |
| One-time VPS setup (Docker, firewall, deploy user) | `deploy/bootstrap-vps.sh` | you, once |

```
Internet ─► Caddy :443 (password gate, certificates)
              └─► client nginx :80 ─┬─ the page and its assets
                                    └─ /api, /rooms, /identity, /health, /socket.io ─► server :3001 ─► Redis, PostgreSQL
```

Only Caddy is reachable from outside (ports 80 and 443). The rest talks over
private Docker networks.

## The username and password in front of the site

Caddy's `basic_auth` works like an `.htaccess` password: the browser asks for a
username and password once, then sends them with every request.
- **Where it's set:** the `SITE_USERNAME` and `SITE_PASSWORD` secrets. The
  deploy writes only the password's bcrypt hash to the VPS.
- **Turning it off:** leave both unset, and the site is open.
- **What stays open, by design:**
  - `/health`, for the deploy check and monitors.
  - `/socket.io/*`. Some browsers (Safari) don't send the password on a
    WebSocket. The socket only serves rooms made through the protected pages,
    to players holding their tokens, so it isn't a way in.
  - The installed app's files: `/manifest.webmanifest`, `/sw.js`,
    `/workbox-*.js` and the icons. Browsers fetch the manifest without the
    password, so installing would fail. These files hold nothing private, and
    the app they open is still behind the password.

## The installable app (PWA)

SkyTeam installs as an app: Chrome or Edge's install icon in the address bar,
Android Chrome's menu → Install app, or iOS Safari's Share → Add to Home Screen.
- **What makes it an app:** `vite-plugin-pwa` (in
  `packages/client/vite.config.ts`) builds the manifest and a service worker.
  The worker keeps the app shell (`index.html` and `/assets/*`), so the app
  opens at once. `/api`, `/rooms`, `/identity`, `/health` and `/socket.io`
  always go to the server.
- **Updates:** a new version waits until the player taps Reload, and the
  Reload bar never shows while a game is on (`src/pwa/UpdateBar.tsx`). nginx
  serves `sw.js` and the manifest with `no-cache`, so a deploy is noticed on
  the next launch, or within the hour while the app is open.
- **The seat:** a phone closes an installed app whenever it likes, so the
  installed app keeps its token and its room in `localStorage` and goes back
  into the room at launch (`src/pwa/installed.ts`). A browser tab is still one
  player per tab.
- **Icons:** drawn in `packages/client/public/icon.svg`. To regenerate the PNGs
  after changing it, from `packages/client`, in `node:22-alpine`, run
  `npx @vite-pwa/assets-generator@2.0.0` (settings in `pwa-assets.config.mjs`).

**Testing it locally.** A service worker only runs on `https://` or
`http://localhost`, and the dev server's hot reload gets in its way. So test
the production build:
1. Stop the dev stack (it uses the same ports), then `docker compose up --build`
   and open http://localhost:8080 in Chrome or Edge. Install it from the address
   bar. DevTools → Application shows the manifest, the service worker (with an
   Offline switch) and Clear site data.
2. **Android, over USB:** turn on USB debugging, open `chrome://inspect` on the
   computer, and under Port forwarding map `8080` to `localhost:8080`. On the
   phone, http://localhost:8080 in Chrome now counts as localhost, so it
   installs.
3. **iPhone:** it needs real HTTPS. A temporary tunnel gives you an
   `https://….trycloudflare.com` address:
   `docker run --rm cloudflare/cloudflared tunnel --url http://host.docker.internal:8080`.
   Open it in Safari, then Share → Add to Home Screen.

## Setting it up (once)

**1. DNS (OVH panel).** An `A` record for `skyteam.mjakubec.eu` → the VPS's
IPv4, and an `AAAA` record if the VPS has IPv6. A wildcard `*.mjakubec.eu`
also works for later apps. Check with `dig +short skyteam.mjakubec.eu`.

**2. Your own SSH key on the VPS.** You need to log in with a key, not only a
password:

```sh
ssh-copy-id ubuntu@<vps-ip>
```

**3. A deploy key** for GitHub Actions. Make it on your computer; it doesn't
belong to any person:

```sh
ssh-keygen -t ed25519 -f skyteam-deploy -N "" -C "skyteam deploy"
```

**4. Set up the VPS.** One script does it all:

```sh
scp deploy/bootstrap-vps.sh ubuntu@<vps-ip>:
ssh ubuntu@<vps-ip> "sudo sh bootstrap-vps.sh '$(cat skyteam-deploy.pub)'"
```

The script:
- installs Docker and automatic security updates;
- creates the `deploy` user, which can log in only with the deploy key;
- opens only SSH, 80 and 443 in the firewall;
- creates `/srv/edge` and `/srv/apps/skyteam`, and the `edge` Docker network;
- turns off password logins for SSH.

**Check from a second terminal that `ssh ubuntu@<vps-ip>` still works before
closing the first.** Running the script again is harmless.

**5. GitHub.** Go to Settings → Environments → New environment →
`production`. Add the values from
[production-variables.md](production-variables.md):
- **Secrets:** your git-ignored `.env.production` has them ready to copy.
- **Deploy access:**
  - `DEPLOY_HOST`: the VPS's IP or name;
  - `DEPLOY_SSH_KEY`: the contents of `skyteam-deploy`, the private key;

The VPS's host keys aren't a secret: they're in `deploy/vps-host-keys`. After
reinstalling the VPS, its keys change: update that file (it says how).

Then delete `skyteam-deploy` from your computer, or keep it somewhere safe.

**6. Deploy.** Publish a release: Releases → Draft a new release, a new tag
such as `v1.0.0` on `main`, then Publish. Or run Actions → Deploy → Run
workflow. The workflow:
1. tests;
2. builds and pushes `ghcr.io/martinjakubec/skyteam-{server,client}` (tagged
   with the commit, and with the release's tag);
3. copies `deploy/` to the VPS and writes the settings;
4. pulls the images and starts everything;
5. checks `https://skyteam.mjakubec.eu/health`.

On the first run, Caddy fetches the certificate.

**7. First sign-in.** Open the site, enter `SITE_USERNAME` / `SITE_PASSWORD`,
then sign in as `SUPERADMIN_USERNAME` with `SUPERADMIN_INITIAL_PASSWORD`, and
**change that password** on the account page.

## Everyday

- **Deploy:** publish a release (a new tag, e.g. `v1.1.0`, on `main`).
- **Change a setting or secret:** edit it in GitHub, then re-run the workflow.
- **Change `POSTGRES_PASSWORD`:** PostgreSQL keeps the password it was first
  started with. After the deploy with the new one, set it in the database too,
  then restart the server:
  ```sh
  cd /srv/apps/skyteam
  docker compose exec postgres sh -c 'psql -U skyteam -c "ALTER USER skyteam PASSWORD '\''$POSTGRES_PASSWORD'\''"'
  docker compose restart server
  ```
- **Roll back:** Actions → Deploy → Run workflow, with "Use workflow from" set
  to an older release's tag. Or on the VPS: set `IMAGE_TAG='<older sha>'` in
  `/srv/apps/skyteam/.env`, then
  `docker compose up -d` in `/srv/apps/skyteam`.
- **Logs:** `ssh deploy@<vps>`, then `cd /srv/apps/skyteam && docker compose
  logs -f server` (or `/srv/edge` for Caddy).
- **Backups:** `/srv/apps/skyteam/backups/skyteam-<date>.sql.gz`, one a night,
  14 days kept. They stay on the VPS: copy them elsewhere now and then
  (`scp deploy@<vps>:/srv/apps/skyteam/backups/* .`).
  - Restore: `gunzip -c skyteam-<date>.sql.gz | docker compose exec -T postgres psql -U skyteam skyteam`.
- **SQL:** `cd /srv/apps/skyteam && docker compose exec postgres psql -U skyteam skyteam`.
- **Reboot:** everything comes back by itself (`restart: unless-stopped`,
  Docker enabled at boot).

## Another app on the same VPS, later

The `edge` network and Caddy are shared. A new app needs:
- a site file in `deploy/edge/sites/` (or in the app's own repository);
- its entry container on the `edge` network with an alias of its own, as
  `skyteam-web` here.

Give it its own `/srv/apps/<app>` and a workflow like this one.

## Checked before the first deploy

The whole stack ran locally from these files (images built as CI builds them,
Caddy with a local certificate). Checked:
- **The password gate:** without the password, `/` and `/api` answer 401, a
  wrong password too, and `/health` answers 200.
- **The game:** with the password, two browsers joined a room over an invite
  link and started a game through Caddy and nginx (WebSocket included).
- **Accounts:** the owner account was created from the settings, and the
  sign-in cookie is `Secure`, `HttpOnly` and `SameSite=Strict`.
- **Backups and restarts:** the nightly backup was written, and the server
  restarted cleanly.

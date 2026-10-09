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

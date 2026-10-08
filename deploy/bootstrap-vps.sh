#!/bin/sh
# One-time setup of a fresh Ubuntu VPS for the deploy workflow. Everything else
# (the edge proxy, the app, its settings) arrives with each deploy.
#
#   scp deploy/bootstrap-vps.sh ubuntu@<vps>:
#   ssh ubuntu@<vps> 'sudo sh bootstrap-vps.sh "<the deploy public key>"'
#
# The key is the public half of the deploy key whose private half is the
# DEPLOY_SSH_KEY secret in GitHub (see docs/deployment.md). Running it again is
# harmless: every step checks before it changes anything.
set -eu

DEPLOY_KEY="${1:-}"
if [ "$(id -u)" -ne 0 ]; then
  echo "Run it as root (sudo sh bootstrap-vps.sh \"<deploy public key>\")." >&2
  exit 1
fi
case "$DEPLOY_KEY" in
  ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*) ;;
  *) echo "Pass the deploy public key (one line, ssh-ed25519 …) as the first argument." >&2; exit 1 ;;
esac

echo "== System updates, and security updates from now on by themselves"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ufw unattended-upgrades curl
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "== Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker containerd

echo "== The deploy user (runs the containers; may log in with the deploy key only)"
if ! id deploy >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" deploy
fi
usermod -aG docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
grep -qxF "$DEPLOY_KEY" /home/deploy/.ssh/authorized_keys || echo "$DEPLOY_KEY" >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

echo "== Folders and the shared network the edge proxy reaches the apps over"
install -d -o deploy -g deploy /srv/edge /srv/edge/auth /srv/apps /srv/apps/skyteam /srv/apps/skyteam/backups
docker network inspect edge >/dev/null 2>&1 || docker network create edge

echo "== Firewall: SSH, HTTP and HTTPS only"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

echo "== SSH: keys only, no root login"
# Only when your own account (the one running sudo) logs in with a key — the
# deploy key lives in GitHub, not with you — so this can't lock you out.
ADMIN_HOME="$(getent passwd "${SUDO_USER:-}" | cut -d: -f6)"
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] && [ -s "$ADMIN_HOME/.ssh/authorized_keys" ]; then
  cat > /etc/ssh/sshd_config.d/10-hardening.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
CONF
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
else
  echo "   Skipped: ${SUDO_USER:-your account} has no SSH key yet. Add one (ssh-copy-id), then run this again."
fi

echo
echo "Done. Check from a second terminal that you can still log in (ssh <you>@<vps>)"
echo "before closing this one. Then set the GitHub secrets (docs/deployment.md) and"
echo "run the Deploy workflow."

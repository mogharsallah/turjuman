#!/usr/bin/env bash
# Idempotent provisioner for a remote (SSH) Turjuman dev box — works whether the
# machine is ephemeral or persistent, and whether run as root (cloud-init) or as a
# normal user. It installs prerequisites only (Node 20, Docker, git) and is a thin
# wrapper over the repo's npm scripts; it does not duplicate any app logic.
#
#   curl -fsSL https://raw.githubusercontent.com/mogharsallah/turjuman/main/scripts/provision-dev.sh | bash
#   # or, on a checkout:  ./scripts/provision-dev.sh
#
# SECURITY: the dev servers (:3000/:4000) and LocalStack (:4566) bind localhost
# only. Do NOT open them in a security group / firewall. Reach them from your
# laptop over SSH forwarding:
#   ssh -L 3000:localhost:3000 -L 4000:localhost:4000 -L 4566:localhost:4566 user@host
# For Zed, use SSH remoting to edit on the box while the stack runs there.
set -euo pipefail

REPO_URL="${TURJUMAN_REPO_URL:-https://github.com/mogharsallah/turjuman.git}"
REPO_DIR="${TURJUMAN_REPO_DIR:-$HOME/turjuman}"

# Run privileged steps with sudo only when not already root.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }

log "Installing base packages (git, curl, ca-certificates)"
if command -v apt-get >/dev/null 2>&1; then
  $SUDO apt-get update -y
  $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates
else
  echo "This script targets Debian/Ubuntu (apt). Install git/curl/Docker/Node 20 manually." >&2
fi

if command -v node >/dev/null 2>&1 && node -e 'process.exit(parseInt(process.versions.node)>=20?0:1)'; then
  log "Node $(node -v) already present (>=20) — skipping"
else
  log "Installing Node 20 (NodeSource, system-wide)"
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
  $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi

if command -v docker >/dev/null 2>&1; then
  log "Docker $(docker --version) already present — skipping"
else
  log "Installing Docker Engine + compose plugin (get.docker.com)"
  curl -fsSL https://get.docker.com | $SUDO sh
fi

# Let the invoking (non-root) user talk to the Docker socket without sudo.
TARGET_USER="${SUDO_USER:-$(id -un)}"
if [ "$TARGET_USER" != "root" ]; then
  log "Adding $TARGET_USER to the 'docker' group"
  $SUDO usermod -aG docker "$TARGET_USER" || true
  NEEDS_RELOGIN=1
fi

log "Fetching the repository into $REPO_DIR"
if [ -d "$REPO_DIR/.git" ]; then
  git -C "$REPO_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$REPO_DIR"
fi

cd "$REPO_DIR"
log "Installing npm dependencies (npm ci)"
npm ci
log "Building all workspaces"
npm run build

log "Starting the shared LocalStack (npm run stack:up)"
if docker info >/dev/null 2>&1; then
  npm run stack:up
else
  echo "Docker daemon not reachable yet (group change needs a new shell)." >&2
  echo "After re-login, run: cd $REPO_DIR && npm run stack:up" >&2
fi

cat <<EOF

------------------------------------------------------------------------
Provisioned. Next steps (run on the box):

  cd $REPO_DIR
  cp -n .env.example .env
  npm run dev:setup you@example.com "You"   # prints your API key ONCE
  npm run dev                               # fast loop (MCP :3000, REST :4000)
  # or: npm run dev:lambda                  # high-fidelity LocalStack Lambda loop

Reach the servers from your laptop via SSH forwarding (they bind localhost only):
  ssh -L 3000:localhost:3000 -L 4000:localhost:4000 -L 4566:localhost:4566 USER@THIS_HOST
------------------------------------------------------------------------
EOF

if [ "${NEEDS_RELOGIN:-0}" = "1" ]; then
  echo "NOTE: log out and back in (or run 'newgrp docker') before using Docker without sudo." >&2
fi

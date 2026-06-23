#!/usr/bin/env bash
# Idempotent provisioner for a remote (SSH) dev box: installs Node 24, Docker, git,
# clones/builds the repo, and starts LocalStack. Runs as root (cloud-init) or user.
#   curl -fsSL .../scripts/provision-dev.sh | bash   # or: ./scripts/provision-dev.sh
# SECURITY: LocalStack (:4566) binds localhost only — reach it via SSH forwarding,
# never a public port (ssh -L 4566:localhost:4566 user@host).
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
  echo "This script targets Debian/Ubuntu (apt). Install git/curl/Docker/Node 24 manually." >&2
fi

if command -v node >/dev/null 2>&1 && node -e 'process.exit(parseInt(process.versions.node)>=24?0:1)'; then
  log "Node $(node -v) already present (>=24) — skipping"
else
  log "Installing Node 24 (NodeSource, system-wide)"
  curl -fsSL https://deb.nodesource.com/setup_24.x | $SUDO -E bash -
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

log "Starting the shared LocalStack (npm run localstack:up)"
if docker info >/dev/null 2>&1; then
  npm run localstack:up
else
  echo "Docker daemon not reachable yet (group change needs a new shell)." >&2
  echo "After re-login, run: cd $REPO_DIR && npm run localstack:up" >&2
fi

cat <<EOF

Provisioned. Next: cd $REPO_DIR && cp -n .env.example .env
  npm run dev                                  # deploy into LocalStack; prints MCP/REST URLs + API key
  ssh -L 4566:localhost:4566 USER@THIS_HOST    # forward LocalStack (it's localhost-only)
EOF

if [ "${NEEDS_RELOGIN:-0}" = "1" ]; then
  echo "NOTE: log out and back in (or run 'newgrp docker') before using Docker without sudo." >&2
fi

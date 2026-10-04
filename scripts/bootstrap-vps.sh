#!/usr/bin/env bash
# One-time setup of an Ubuntu 22.04/24.04 VPS for Agentic Yield Vaults:
# Docker (Stylus reproducible builds + nitro-devnode), Node 22 + pnpm + pm2, Foundry,
# Rust 1.91 + wasm32 + cargo-stylus 0.10.10, Caddy (HTTPS for the agent API).
# Usage: sudo -E bash scripts/bootstrap-vps.sh <agent-domain>   (e.g. 147-93-178-184.sslip.io)
#        SKIP_STYLUS=1 to skip the Rust/cargo-stylus toolchain (hosted fork demo only).
set -euo pipefail

DOMAIN="${1:-}"
RUN_USER="${SUDO_USER:-$USER}"
as_user() { sudo -u "$RUN_USER" -H bash -lc "$*"; }

echo "==> base packages"
apt-get update -y
apt-get install -y ca-certificates curl git build-essential pkg-config libssl-dev jq ufw debian-keyring debian-archive-keyring apt-transport-https

echo "==> docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
  usermod -aG docker "$RUN_USER"
fi

echo "==> node 22 + pnpm + pm2"
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
npm install -g pnpm@11 pm2

echo "==> foundry"
as_user 'command -v forge >/dev/null || (curl -L https://foundry.paradigm.xyz | bash && ~/.foundry/bin/foundryup)'

if [ "${SKIP_STYLUS:-0}" != "1" ]; then
  echo "==> rust 1.91 + wasm32 + cargo-stylus (limited parallelism to avoid OOM)"
  as_user 'command -v rustup >/dev/null || curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal'
  as_user 'source ~/.cargo/env && rustup toolchain install 1.91.0 --profile minimal -t wasm32-unknown-unknown'
  as_user 'source ~/.cargo/env && (command -v cargo-stylus >/dev/null || cargo install --locked -j 4 cargo-stylus --version 0.10.10)'
else
  echo "==> SKIP_STYLUS=1: skipping Rust/cargo-stylus (not needed for the hosted fork demo)"
fi

echo "==> caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi
if [ -n "$DOMAIN" ]; then
  sed "s/{\$AGENT_DOMAIN}/$DOMAIN/" "$(dirname "$0")/../deploy/Caddyfile" > /etc/caddy/Caddyfile
  systemctl reload caddy || systemctl restart caddy
fi

echo "==> firewall (ssh + https only; the agent listens on localhost behind Caddy)"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> done. Log out/in for the docker group, then:"
echo "    cp .env.example .env && chmod 600 .env   # or copy your .env securely"
echo "    (cd agent && pnpm install) && pm2 start deploy/ecosystem.config.cjs && pm2 save"

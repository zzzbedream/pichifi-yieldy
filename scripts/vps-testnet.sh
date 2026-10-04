#!/usr/bin/env bash
# Hosted agent for the LIVE Robinhood Chain testnet deployment (deployments/robinhood-testnet.json).
# Stops the demo fork, runs the agent under pm2 against testnet, and exposes the public testnet RPC
# at POST /rpc (method-filtered) so the Vercel dashboard and wallets stay on one domain.
#
#   VERCEL_URL=https://pichifi-yieldy.vercel.app AGENT_PUBLIC_URL=https://<IP>.sslip.io ./scripts/vps-testnet.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NETWORK=robinhood-testnet
RPC="${TESTNET_RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
VERCEL_URL="${VERCEL_URL:-}"
PUBLIC="${AGENT_PUBLIC_URL:-https://<your-domain>}"
set -a; source "$ROOT/.env"; set +a

DEPLOY="$ROOT/deployments/$NETWORK.json"
[ -f "$DEPLOY" ] || { echo "missing $DEPLOY: run scripts/deploy-testnet.sh and git pull"; exit 1; }
VAULT=$(node -e "console.log(require(require('path').resolve(process.argv[1])).vault)" "$DEPLOY")
echo "==> agent for vault $VAULT on $RPC"

wait_http() { for _ in $(seq 1 60); do curl -s -m 2 "$1" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
pm2 ping >/dev/null 2>&1 || { pm2 kill >/dev/null 2>&1 || true; pm2 ping >/dev/null; }
pm2 delete ayv-anvil ayv-agent >/dev/null 2>&1 || true

CORS="http://localhost:3000${VERCEL_URL:+,$VERCEL_URL}"
(cd "$ROOT/agent" && RPC_URL="$RPC" VAULT_ADDRESS="$VAULT" SIGNER_SCHEME=bls AMADEUS_ANCHOR_ENABLED=false \
  DATA_DIR="data/$NETWORK" TICK_SECONDS=30 CORS_ORIGIN="$CORS" FORK_RPC_PROXY_UPSTREAM="$RPC" \
  pm2 start node_modules/.bin/tsx --name ayv-agent --interpreter none --update-env -- src/main.ts >/dev/null)
wait_http http://127.0.0.1:8787/health || { echo "agent did not start (pm2 logs ayv-agent)"; exit 1; }
pm2 save >/dev/null

if [ -n "$VERCEL_URL" ]; then
  node "$ROOT/scripts/sync-frontend-env.mjs" "$NETWORK" "$VERCEL_URL/agent" >/dev/null
  sed -i "s#^NEXT_PUBLIC_RPC_URL=.*#NEXT_PUBLIC_RPC_URL=$VERCEL_URL/rpc#" "$ROOT/frontend/.env.local"
  echo "AGENT_ORIGIN=$PUBLIC" >> "$ROOT/frontend/.env.local"
else
  node "$ROOT/scripts/sync-frontend-env.mjs" "$NETWORK" "$PUBLIC" >/dev/null
fi
echo
echo "Ready (testnet). Vercel environment variables:"
cat "$ROOT/frontend/.env.local"

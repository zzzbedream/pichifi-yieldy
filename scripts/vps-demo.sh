#!/usr/bin/env bash
# Hosted demo on the VPS: a Robinhood Chain testnet FORK (anvil, Prague) + the full stack
# deployed with the same DeployAll script + the agent, all under pm2. Caddy (bootstrap-vps.sh)
# serves the agent over HTTPS; the agent also exposes the fork at POST /rpc (method-filtered),
# so the Vercel dashboard can read the chain and wallets can send transactions.
#
#   FORK_URL=https://robinhood-testnet.g.alchemy.com/v2/<key> \
#   VERCEL_URL=https://pichifi-yieldy.vercel.app \
#   ./scripts/vps-demo.sh [--fund 0xWallet ...]
#
# Re-run any time to reset the demo (same deterministic addresses).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPC=http://127.0.0.1:8545
FORK_URL="${FORK_URL:-https://rpc.testnet.chain.robinhood.com}"
VERCEL_URL="${VERCEL_URL:-}"
set -a; source "$ROOT/.env"; set +a
export PATH="$HOME/.foundry/bin:$PATH"
ANVIL="$(command -v anvil || true)"
[ -n "$ANVIL" ] || { echo "anvil not found: install Foundry (curl -L https://foundry.paradigm.xyz | bash && ~/.foundry/bin/foundryup)"; exit 1; }

wait_http() { for _ in $(seq 1 60); do curl -s -m 2 "$1" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }

if [ "${1:-}" = "--fund" ]; then
  shift
  for w in "$@"; do cast rpc anvil_setBalance "$w" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null && echo "funded $w with 100 ETH (fork)"; done
  exit 0
fi

echo "==> (re)starting fork of $FORK_URL"
# Make sure the pm2 daemon is up (a stale or half-started daemon fails with "God db process id unknown").
pm2 ping >/dev/null 2>&1 || { pm2 kill >/dev/null 2>&1 || true; pm2 ping >/dev/null; }
pm2 delete ayv-anvil ayv-agent >/dev/null 2>&1 || true
pm2 start "$ANVIL" --name ayv-anvil --interpreter none -- --fork-url "$FORK_URL" --hardfork prague --port 8545 --silent >/dev/null
wait_http "$RPC" || { echo "anvil did not start (pm2 logs ayv-anvil)"; exit 1; }
cast rpc evm_setNextBlockTimestamp "$(date +%s)" --rpc-url "$RPC" >/dev/null
for key in "$DEPLOYER_PRIVATE_KEY" "$RELAYER_PRIVATE_KEY"; do
  cast rpc anvil_setBalance "$(cast wallet address "$key")" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
done

echo "==> deploy (same script as testnet)"
(cd "$ROOT/agent" && pnpm -s tsx scripts/agent-identity.ts)
(cd "$ROOT/contracts/evm" && NETWORK_NAME=vps-fork forge script script/DeployAll.s.sol --rpc-url "$RPC" --broadcast --slow > /tmp/ayv-deploy.log 2>&1) \
  || { echo "deploy failed (see /tmp/ayv-deploy.log)"; exit 1; }
VAULT=$(node -e "console.log(require(require('path').resolve(process.argv[1])).vault)" "$ROOT/deployments/vps-fork.json")
echo "    vault $VAULT"

echo "==> agent (pm2: ayv-agent)"
rm -rf "$ROOT/agent/data/vps-fork"
CORS="http://localhost:3000${VERCEL_URL:+,$VERCEL_URL}"
(cd "$ROOT/agent" && RPC_URL="$RPC" VAULT_ADDRESS="$VAULT" SIGNER_SCHEME=bls AMADEUS_ANCHOR_ENABLED=false \
  DATA_DIR=data/vps-fork TICK_SECONDS=10 CORS_ORIGIN="$CORS" FORK_RPC_PROXY_UPSTREAM="$RPC" \
  pm2 start node_modules/.bin/tsx --name ayv-agent --interpreter none --update-env -- src/main.ts >/dev/null)
wait_http http://127.0.0.1:8787/health || { echo "agent did not start (pm2 logs ayv-agent)"; exit 1; }
pm2 save >/dev/null

PUBLIC="${AGENT_PUBLIC_URL:-https://<your-domain>}"
if [ -n "$VERCEL_URL" ]; then
  # Vercel proxies /agent/* and /rpc to the VPS (frontend/next.config.ts), so the dashboard,
  # its API and the wallet RPC all live on the Vercel domain.
  node "$ROOT/scripts/sync-frontend-env.mjs" vps-fork "$VERCEL_URL/agent" >/dev/null
  sed -i "s#^NEXT_PUBLIC_RPC_URL=.*#NEXT_PUBLIC_RPC_URL=$VERCEL_URL/rpc#" "$ROOT/frontend/.env.local"
  echo "AGENT_ORIGIN=$PUBLIC" >> "$ROOT/frontend/.env.local"
else
  node "$ROOT/scripts/sync-frontend-env.mjs" vps-fork "$PUBLIC" >/dev/null
  sed -i "s#^NEXT_PUBLIC_RPC_URL=.*#NEXT_PUBLIC_RPC_URL=$PUBLIC/rpc#" "$ROOT/frontend/.env.local"
fi
echo
echo "Ready. Vercel environment variables (Project Settings -> Environment Variables):"
cat "$ROOT/frontend/.env.local"
echo
echo "Fund a demo wallet on the fork: ./scripts/vps-demo.sh --fund 0xYourWallet"

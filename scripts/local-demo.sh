#!/usr/bin/env bash
# Backup demo: the full stack on a local fork of Robinhood Chain testnet (chain 46630,
# Robinhood's real Uniswap v4 PoolManager, live EIP-2537 precompiles via Prague) with the
# real agent and dashboard. Use it to rehearse or record when testnet ETH is unavailable;
# label the recording as "Robinhood testnet fork".
#
#   INVESTOR_ADDRESS=0xYourMetaMask ./scripts/local-demo.sh
#
# Then add a MetaMask network: RPC http://127.0.0.1:8545, chain id 46630, symbol ETH,
# and open http://localhost:3000 . Stop everything with: ./scripts/local-demo.sh stop
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPC=http://127.0.0.1:8545
UPSTREAM="${FORK_URL:-https://rpc.testnet.chain.robinhood.com}"
LOGS="$ROOT/agent/data/local-demo"
mkdir -p "$LOGS"

port_pids() { (command -v lsof >/dev/null && lsof -ti tcp:"$1") || \
  (command -v powershell >/dev/null && powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort $1 -State Listen -ErrorAction SilentlyContinue).OwningProcess" | tr -d '\r') || true; }
stop_all() {
  for port in 8545 8787 3000; do
    for pid in $(port_pids "$port"); do
      [ -n "$pid" ] && { kill "$pid" 2>/dev/null || taskkill //F //PID "$pid" >/dev/null 2>&1 || true; }
    done
  done
}
if [ "${1:-}" = "stop" ]; then stop_all; echo "stopped"; exit 0; fi
stop_all

set -a; source "$ROOT/.env"; set +a
wait_http() { for _ in $(seq 1 60); do curl -s -m 2 "$1" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }

echo "==> fork $UPSTREAM"
nohup anvil --fork-url "$UPSTREAM" --hardfork prague --port 8545 --silent > "$LOGS/anvil.log" 2>&1 &
wait_http "$RPC" || { echo "anvil did not start"; exit 1; }
cast rpc evm_setNextBlockTimestamp "$(date +%s)" --rpc-url "$RPC" >/dev/null
for key in "$DEPLOYER_PRIVATE_KEY" "$RELAYER_PRIVATE_KEY"; do
  cast rpc anvil_setBalance "$(cast wallet address "$key")" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
done
[ -n "${INVESTOR_ADDRESS:-}" ] && cast rpc anvil_setBalance "$INVESTOR_ADDRESS" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null

echo "==> deploy (same script as testnet)"
(cd "$ROOT/agent" && pnpm -s tsx scripts/agent-identity.ts)
(cd "$ROOT/contracts/evm" && NETWORK_NAME=local-fork forge script script/DeployAll.s.sol --rpc-url "$RPC" --broadcast --slow > "$LOGS/deploy.log" 2>&1) \
  || { echo "deploy failed, see $LOGS/deploy.log"; exit 1; }
VAULT=$(node -e "console.log(require(require('path').resolve(process.argv[1])).vault)" "$ROOT/deployments/local-fork.json")
echo "    vault $VAULT"

echo "==> agent on :8787"
rm -rf "$ROOT/agent/data/local-fork"
(cd "$ROOT/agent" && RPC_URL="$RPC" VAULT_ADDRESS="$VAULT" SIGNER_SCHEME=bls AMADEUS_ANCHOR_ENABLED=false \
  DATA_DIR=data/local-fork TICK_SECONDS=10 CORS_ORIGIN=http://localhost:3000 \
  nohup pnpm -s tsx src/main.ts > "$LOGS/agent.log" 2>&1 &)
wait_http http://127.0.0.1:8787/health || { echo "agent did not start, see $LOGS/agent.log"; exit 1; }

echo "==> dashboard on :3000"
node "$ROOT/scripts/sync-frontend-env.mjs" local-fork http://127.0.0.1:8787
sed -i 's#^NEXT_PUBLIC_RPC_URL=.*#NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8545#' "$ROOT/frontend/.env.local"
(cd "$ROOT/frontend" && nohup pnpm -s next dev -p 3000 > "$LOGS/frontend.log" 2>&1 &)
wait_http http://localhost:3000 || { echo "dashboard did not start, see $LOGS/frontend.log"; exit 1; }

cat <<EOF

Ready.
  Dashboard  http://localhost:3000   (MetaMask network: RPC $RPC, chain id 46630)
  Agent API  http://127.0.0.1:8787   presenter token = DEMO_API_TOKEN in .env
  Scripted run: (cd agent && E2E_RPC_URL=$RPC pnpm tsx scripts/e2e-demo.ts local-fork)
  Stop: ./scripts/local-demo.sh stop
EOF

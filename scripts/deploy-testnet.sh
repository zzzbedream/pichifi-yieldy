#!/usr/bin/env bash
# Deploys the full Agentic Yield Vaults stack to Robinhood Chain testnet and wires the
# agent + dashboard config. Requires: foundry, node/pnpm, a funded DEPLOYER_PRIVATE_KEY in .env.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NETWORK="${NETWORK_NAME:-robinhood-testnet}"
set -a; source "$ROOT/.env"; set +a
RPC="${RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
EXPLORER="${EXPLORER_URL:-https://explorer.testnet.chain.robinhood.com}"

echo "==> exporting agent public identity"
(cd "$ROOT/agent" && pnpm -s tsx scripts/agent-identity.ts)

echo "==> deploying to $NETWORK ($RPC)"
(cd "$ROOT/contracts/evm" && NETWORK_NAME="$NETWORK" forge script script/DeployAll.s.sol \
  --rpc-url "$RPC" --broadcast --slow   --verify --verifier blockscout --verifier-url "$EXPLORER/api/") || {
  echo "!! deploy or verification failed; if the broadcast succeeded, re-run scripts/verify-testnet.sh"; exit 1; }

DEPLOY="$ROOT/deployments/$NETWORK.json"
VAULT=$(node -e "console.log(require('$DEPLOY').vault)")
echo "==> vault $VAULT"

# Point the agent at the new vault (.env is gitignored).
if grep -q '^VAULT_ADDRESS=' "$ROOT/.env"; then
  sed -i.bak "s#^VAULT_ADDRESS=.*#VAULT_ADDRESS=$VAULT#" "$ROOT/.env" && rm -f "$ROOT/.env.bak"
else
  echo "VAULT_ADDRESS=$VAULT" >> "$ROOT/.env"
fi

node "$ROOT/scripts/sync-frontend-env.mjs" "$NETWORK" "${AGENT_PUBLIC_URL:-http://localhost:8787}"
echo "==> done. Contracts verified on $EXPLORER. Next: start the agent (cd agent && pnpm start) and the dashboard."

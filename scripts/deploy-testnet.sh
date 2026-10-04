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
(cd "$ROOT/contracts/evm" && NETWORK_NAME="$NETWORK" forge script script/DeployAll.s.sol   --rpc-url "$RPC" --broadcast --slow)

echo "==> verifying on Blockscout ($EXPLORER) — non-fatal, re-run scripts/verify-testnet.sh if needed"
"$ROOT/scripts/verify-testnet.sh" || echo "!! some verifications failed; re-run scripts/verify-testnet.sh"

DEPLOY="$ROOT/deployments/$NETWORK.json"
VAULT=$(node -e "console.log(require(require('path').resolve(process.argv[1])).vault)" "$DEPLOY")
echo "==> vault $VAULT"

# Point the agent at the new vault (.env is gitignored).
if grep -q '^VAULT_ADDRESS=' "$ROOT/.env"; then
  sed -i.bak "s#^VAULT_ADDRESS=.*#VAULT_ADDRESS=$VAULT#" "$ROOT/.env" && rm -f "$ROOT/.env.bak"
else
  echo "VAULT_ADDRESS=$VAULT" >> "$ROOT/.env"
fi

node "$ROOT/scripts/sync-frontend-env.mjs" "$NETWORK" "${AGENT_PUBLIC_URL:-http://localhost:8787}"
echo "==> done. Next: start the agent (cd agent && pnpm start) and the dashboard (cd frontend && pnpm dev)."

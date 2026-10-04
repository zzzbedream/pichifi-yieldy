#!/usr/bin/env bash
# Re-runs Blockscout verification for the last DeployAll broadcast without redeploying.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$ROOT/.env"; set +a
RPC="${RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
EXPLORER="${EXPLORER_URL:-https://explorer.testnet.chain.robinhood.com}"
cd "$ROOT/contracts/evm"
NETWORK_NAME="${NETWORK_NAME:-robinhood-testnet}" forge script script/DeployAll.s.sol \
  --rpc-url "$RPC" --resume --verify --verifier blockscout --verifier-url "$EXPLORER/api/"

#!/usr/bin/env bash
# Pre-deploy checks for Robinhood Chain testnet. Prints only public addresses and balances.
#   EXPECTED_DEPLOYER=0x... ./scripts/testnet-preflight.sh                 # check
#   EXPECTED_DEPLOYER=0x... ./scripts/testnet-preflight.sh --fund-relayer  # also top up the relayer
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$ROOT/.env"; set +a
export PATH="$HOME/.foundry/bin:$PATH"
RPC="${RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
RELAYER_MIN_WEI=1000000000000000   # 0.001 ETH
RELAYER_TOPUP=0.002ether

chain=$(cast chain-id --rpc-url "$RPC")
[ "$chain" = "46630" ] || { echo "RPC_URL is chain $chain, expected 46630 (Robinhood testnet)"; exit 1; }

deployer=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
relayer=$(cast wallet address --private-key "$RELAYER_PRIVATE_KEY")
if [ -n "${EXPECTED_DEPLOYER:-}" ] && [ "$(echo "$deployer" | tr A-F a-f)" != "$(echo "$EXPECTED_DEPLOYER" | tr A-F a-f)" ]; then
  echo "DEPLOYER_PRIVATE_KEY controls $deployer, not $EXPECTED_DEPLOYER: fix .env"; exit 1
fi

echo "deployer $deployer  $(cast balance "$deployer" --ether --rpc-url "$RPC") ETH"
echo "relayer  $relayer  $(cast balance "$relayer" --ether --rpc-url "$RPC") ETH"
echo "guardian ${GUARDIAN_ADDRESS:-<deployer>}"

if [ "${1:-}" = "--fund-relayer" ] && [ "$(cast balance "$relayer" --rpc-url "$RPC")" -lt "$RELAYER_MIN_WEI" ]; then
  echo "==> sending $RELAYER_TOPUP to the relayer"
  cast send "$relayer" --value "$RELAYER_TOPUP" --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC" >/dev/null
  echo "relayer  $relayer  $(cast balance "$relayer" --ether --rpc-url "$RPC") ETH"
fi

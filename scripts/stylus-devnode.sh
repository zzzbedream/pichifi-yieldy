#!/usr/bin/env bash
# Runs the CANONICAL Rust/Stylus contracts end to end on a local Arbitrum Nitro devnode,
# where Stylus activation is not paused. Linux/WSL with Docker, Foundry, Node/pnpm and
# cargo-stylus 0.10.10 (scripts/bootstrap-vps.sh installs everything).
#
#   ./scripts/stylus-devnode.sh            # devnode + deploy + agent + E2E
#
# Flow (same orchestration verified on a clean local chain):
#   1. forge  DEPLOY_PHASE=infra  -> mock USDG/rhNVDA, oracle, Morpho Blue + market, v4 PoolManager
#   2. cargo stylus deploy        -> FeeEngine, AmadeusBlsVerifier, AgenticVault (Rust)
#   3. forge  DEPLOY_PHASE=pool   -> salt-mined DynamicFeeHook, pool, adapter wired to the Rust vault
#   4. agent + scripts/e2e-demo.ts against the Rust vault
#
# The vault WASM is ~53 KB compressed, so the devnode must run ArbOS 61+ (fragmented contracts)
# with EIP-2537 precompiles: set NITRO_NODE_VERSION to a Nitro >= v3.12 image if the devnode
# default is older.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPC="${DEVNODE_RPC:-http://localhost:8547}"
# nitro-devnode's documented pre-funded development key (public, local chain only).
PK="${DEVNODE_PRIVATE_KEY:-0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659}"
NETWORK=stylus-devnode
DEPLOY="$ROOT/deployments/$NETWORK.json"
ID="$ROOT/deployments/agent-identity.json"

rpc_up() { curl -s -m 2 -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC" | grep -q result; }

if ! rpc_up; then
  echo "==> starting nitro-devnode"
  [ -d /tmp/nitro-devnode ] || git clone --depth 1 https://github.com/OffchainLabs/nitro-devnode /tmp/nitro-devnode
  (cd /tmp/nitro-devnode && nohup ./run-dev-node.sh > /tmp/nitro-devnode.log 2>&1 &)
  for _ in $(seq 1 90); do rpc_up && break; sleep 2; done
  rpc_up || { echo "devnode did not start (see /tmp/nitro-devnode.log)"; exit 1; }
fi
CHAIN_ID=$(cast chain-id --rpc-url "$RPC")
DEP=$(cast wallet address "$PK")
echo "==> devnode chain $CHAIN_ID, deployer $DEP"

export DEPLOYER_PRIVATE_KEY="$PK" GUARDIAN_ADDRESS="${GUARDIAN_ADDRESS:-$DEP}" NETWORK_NAME="$NETWORK"
(cd "$ROOT/agent" && pnpm -s tsx scripts/agent-identity.ts)
json() { node -e "console.log(require('$1')$2)"; }

echo "==> [1/4] infra (Solidity): tokens, oracle, Morpho, PoolManager"
(cd "$ROOT/contracts/evm" && DEPLOY_PHASE=infra DEPLOY_POOL_MANAGER=true \
  forge script script/DeployAll.s.sol --rpc-url "$RPC" --broadcast --slow)

stylus_deploy() {
  local crate="$1"; shift
  (cd "$ROOT/contracts/stylus/$crate" && cargo stylus deploy -e "$RPC" --private-key "$PK" --no-verify \
    --constructor-args "$@" 2>&1 | tee "/tmp/stylus-$crate.log" \
    | sed 's/\x1b\[[0-9;]*m//g' | grep -oE 'deployed code at address: 0x[0-9a-fA-F]{40}' | awk '{print $NF}' | tail -1)
}

echo "==> [2/4] Rust/Stylus: FeeEngine, AmadeusBlsVerifier, AgenticVault"
FEE_ENGINE=$(stylus_deploy fee-engine "$DEP" 3000 50000 2)
VERIFIER=$(stylus_deploy bls-verifier "$DEP" "$(json "$ID" .blsPublicKeyUncompressed)" \
  "$(json "$ID" .blsPublicKeyCompressed)" "$(json "$ID" .blsDst)")
VAULT=$(stylus_deploy vault "$DEP" "$GUARDIAN_ADDRESS" "$(json "$DEPLOY" .usdg)" "$VERIFIER" "$FEE_ENGINE" \
  "$(json "$DEPLOY" .morpho)" "$(json "$DEPLOY" .stockToken)" "$(json "$DEPLOY" .oracle)" "$(json "$DEPLOY" .irm)" 770000000000000000)
for v in FEE_ENGINE VERIFIER VAULT; do
  [ -n "${!v}" ] || { echo "cargo stylus deploy failed for $v (see /tmp/stylus-*.log)"; exit 1; }
  echo "    $v=${!v}"
done

echo "==> [3/4] pool (Solidity): hook, pool, adapter -> Rust vault"
(cd "$ROOT/contracts/evm" && DEPLOY_PHASE=pool EXT_FEE_ENGINE="$FEE_ENGINE" EXT_VAULT="$VAULT" EXT_VERIFIER="$VERIFIER" \
  forge script script/DeployAll.s.sol --rpc-url "$RPC" --broadcast --slow)

echo "==> [4/4] agent + E2E against the Rust vault"
(cd "$ROOT/agent" && CHAIN_ID="$CHAIN_ID" RPC_URL="$RPC" VAULT_ADDRESS="$VAULT" AGENT_PORT=8789 RELAYER_PRIVATE_KEY="$PK" \
  AMADEUS_ANCHOR_ENABLED=false DATA_DIR=data/stylus-devnode TICK_SECONDS=10 nohup pnpm -s tsx src/main.ts > /tmp/agent-stylus.log 2>&1 &)
sleep 10
(cd "$ROOT/agent" && INVESTOR_PRIVATE_KEY="$PK" E2E_RPC_URL="$RPC" E2E_AGENT_API_URL=http://127.0.0.1:8789 \
  pnpm -s tsx scripts/e2e-demo.ts "$NETWORK")

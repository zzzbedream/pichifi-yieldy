#!/usr/bin/env bash
# Verifies every contract of the last DeployAll broadcast on Blockscout, one by one.
# Reads addresses from the broadcast record, so it needs no wallet and never sends a transaction.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$ROOT/.env"; set +a
export PATH="$HOME/.foundry/bin:$PATH"
RPC="${RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
EXPLORER="${EXPLORER_URL:-https://explorer.testnet.chain.robinhood.com}"
CHAIN_ID="${CHAIN_ID:-46630}"
cd "$ROOT/contracts/evm"
RUN="broadcast/DeployAll.s.sol/$CHAIN_ID/run-latest.json"
[ -f "$RUN" ] || { echo "no broadcast record at $RUN"; exit 1; }
LOG="$(mktemp)"

# One line per created contract: <name> <address> <compiler version from its build artifact>.
contracts() {
  node -e "
    const fs = require('fs'), path = require('path'), seen = new Set();
    const version = (name) => {
      for (const dir of fs.readdirSync('out')) {
        const f = path.join('out', dir, name + '.json');
        if (fs.existsSync(f)) return 'v' + JSON.parse(fs.readFileSync(f, 'utf8')).metadata.compiler.version;
      }
      return 'unknown';
    };
    for (const t of require(path.resolve(process.argv[1])).transactions) {
      if (!/^CREATE2?$/.test(t.transactionType) || seen.has(t.contractAddress)) continue;
      seen.add(t.contractAddress);
      console.log(t.contractName, t.contractAddress, version(t.contractName));
    }
  " "$RUN"
}

failed=0
while read -r name address compiler; do
  printf '%-26s %s %s ... ' "$name" "$address" "$compiler"
  if forge verify-contract "$address" "$name" --compiler-version "$compiler" --chain-id "$CHAIN_ID" \
       --rpc-url "$RPC" --guess-constructor-args --verifier blockscout --verifier-url "$EXPLORER/api/" \
       --watch > "$LOG" 2>&1 || grep -qi "already verified" "$LOG"; then
    echo ok
  else
    echo "FAILED ($(grep -m1 -iE 'error|fail' "$LOG" | cut -c1-120))"; failed=$((failed + 1))
  fi
done < <(contracts)
rm -f "$LOG"
echo "verification failures: $failed"
[ "$failed" -eq 0 ]

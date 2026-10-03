#!/usr/bin/env node
// Writes frontend/.env.local from deployments/<network>.json (public addresses only).
// Usage: node scripts/sync-frontend-env.mjs [network] [agentApiUrl]
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const network = process.argv[2] ?? 'robinhood-testnet';
const agentApi = process.argv[3] ?? 'http://localhost:8787';
const d = JSON.parse(readFileSync(resolve(root, 'deployments', `${network}.json`), 'utf8'));
const explorer = d.chainId === 4663 ? 'https://robinhoodchain.blockscout.com' : 'https://explorer.testnet.chain.robinhood.com';
const rpc = d.chainId === 4663 ? 'https://rpc.mainnet.chain.robinhood.com' : 'https://rpc.testnet.chain.robinhood.com';

const env = {
  NEXT_PUBLIC_CHAIN_ID: d.chainId,
  NEXT_PUBLIC_RPC_URL: rpc,
  NEXT_PUBLIC_EXPLORER_URL: explorer,
  NEXT_PUBLIC_AGENT_API_URL: agentApi,
  NEXT_PUBLIC_VAULT_BUILD: d.build?.startsWith('stylus') ? 'stylus' : 'solidity',
  NEXT_PUBLIC_DEMO: '1',
  NEXT_PUBLIC_VAULT_ADDRESS: d.vault,
  NEXT_PUBLIC_FEE_ENGINE_ADDRESS: d.feeEngine,
  NEXT_PUBLIC_VERIFIER_ADDRESS: d.blsVerifier,
  NEXT_PUBLIC_ADAPTER_ADDRESS: d.adapter,
  NEXT_PUBLIC_HOOK_ADDRESS: d.hook,
  NEXT_PUBLIC_USDG_ADDRESS: d.usdg,
  NEXT_PUBLIC_STOCK_TOKEN_ADDRESS: d.stockToken,
  NEXT_PUBLIC_MORPHO_ADDRESS: d.morpho,
  NEXT_PUBLIC_IRM_ADDRESS: d.irm,
  NEXT_PUBLIC_MARKET_ID: d.marketId,
};
const body = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
writeFileSync(resolve(root, 'frontend', '.env.local'), body);
console.log(`frontend/.env.local written for ${network} (vault ${d.vault})`);

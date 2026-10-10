/**
 * Amadeus anchor smoke test: shows the agent's AMA balance and, with --mint, anchors one test
 * token in the AYVINTENTS collection through the same anchorer the agent uses.
 *
 *   pnpm tsx scripts/anchor-smoke.ts [mainnet|testnet]           # balance only
 *   pnpm tsx scripts/anchor-smoke.ts [mainnet|testnet] --mint    # + one anchor transaction
 */
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { keccak256, toHex } from 'viem';
import { AmadeusSDK, NETWORK_CONFIGS, NetworkType, deriveSkAndSeed64FromBase58Seed, getPublicKey, toBase58 } from '@amadeus-protocol/sdk';
import { createAmadeusAnchorer } from '../src/amadeus/anchor.js';
import { logger } from '../src/log.js';

loadEnv({ path: resolve(import.meta.dirname, '../../.env') });
const network = process.argv[2] === 'testnet' ? 'testnet' : 'mainnet';
const seed = process.env.AMADEUS_SEED_B58;
if (!seed) throw new Error('AMADEUS_SEED_B58 is not set in .env');

const config = NETWORK_CONFIGS[network === 'mainnet' ? NetworkType.MAINNET : NetworkType.TESTNET];
const sdk = new AmadeusSDK({ baseUrl: config.rpcUrl, timeout: 20_000 });
const address = toBase58(getPublicKey(deriveSkAndSeed64FromBase58Seed(seed).seed64));
const balance = await sdk.wallet.getBalance(address, 'AMA');
console.log(`agent ${address} on Amadeus ${network}: ${balance.balance.float} AMA`);

if (process.argv.includes('--mint')) {
  const anchorer = createAmadeusAnchorer(seed, network, logger);
  const digest = keccak256(toHex(`ayv-anchor-smoke-${Date.now()}`));
  const result = await anchorer.anchor(0n, digest);
  if (!result) {
    console.log('anchor FAILED (see the warning above)');
    process.exit(1);
  }
  console.log(`anchored: ${result.explorerUrl}`);
}

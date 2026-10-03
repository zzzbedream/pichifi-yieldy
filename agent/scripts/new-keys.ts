/**
 * Generates the testnet key set and writes it to the repo-root `.env` (gitignored).
 * Only PUBLIC addresses are printed. Refuses to overwrite keys that already exist.
 * Usage: pnpm keys:new
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { derivePublicKeyFromSeedBase58, generateKeypair } from '@amadeus-protocol/sdk';
import { randomBytes } from 'node:crypto';

const envPath = resolve(import.meta.dirname, '../../.env');
const examplePath = resolve(import.meta.dirname, '../../.env.example');
const current = existsSync(envPath) ? readFileSync(envPath, 'utf8') : readFileSync(examplePath, 'utf8');

function valueOf(env: string, key: string): string {
  const match = env.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match?.[1]?.trim() ?? '';
}

function setValue(env: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  return new RegExp(`^${key}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${key}=.*$`, 'm'), line) : `${env.trimEnd()}\n${line}\n`;
}

let env = current;
const created: string[] = [];
for (const key of ['DEPLOYER_PRIVATE_KEY', 'RELAYER_PRIVATE_KEY', 'GUARDIAN_PRIVATE_KEY', 'AGENT_ECDSA_PRIVATE_KEY']) {
  if (!valueOf(env, key)) {
    env = setValue(env, key, generatePrivateKey());
    created.push(key);
  }
}
if (!valueOf(env, 'AMADEUS_SEED_B58')) {
  env = setValue(env, 'AMADEUS_SEED_B58', generateKeypair().privateKey);
  created.push('AMADEUS_SEED_B58');
}
if (!valueOf(env, 'DEMO_API_TOKEN')) {
  env = setValue(env, 'DEMO_API_TOKEN', randomBytes(24).toString('hex'));
  created.push('DEMO_API_TOKEN');
}
const guardian = privateKeyToAccount(valueOf(env, 'GUARDIAN_PRIVATE_KEY') as `0x${string}`).address;
env = setValue(env, 'GUARDIAN_ADDRESS', guardian);
writeFileSync(envPath, env);

const addr = (key: string) => privateKeyToAccount(valueOf(env, key) as `0x${string}`).address;
const amadeus = derivePublicKeyFromSeedBase58(valueOf(env, 'AMADEUS_SEED_B58'));
console.log(`.env updated (${created.length ? `created: ${created.join(', ')}` : 'no new keys'})`);
console.log('Fund with Robinhood testnet ETH (https://faucet.testnet.chain.robinhood.com):');
console.log(`  deployer  ${addr('DEPLOYER_PRIVATE_KEY')}`);
console.log(`  relayer   ${addr('RELAYER_PRIVATE_KEY')}`);
console.log(`  guardian  ${guardian}  (optional, only for pause/emergency demo)`);
console.log(`Agent ECDSA fallback signer: ${addr('AGENT_ECDSA_PRIVATE_KEY')}`);
console.log(`Amadeus agent address (fund via https://mcp.ama.one/testnet-faucet): ${amadeus}`);


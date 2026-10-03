/**
 * Exports the agent's PUBLIC identity (no secrets) to deployments/agent-identity.json,
 * consumed by the Foundry deploy script to configure the on-chain verifiers.
 * Usage: pnpm tsx scripts/agent-identity.ts
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { stringToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createBlsSigner } from '../src/signing/signer.js';
import { INTENT_DST } from '../src/amadeus/bls.js';

loadEnv({ path: resolve(import.meta.dirname, '../../.env') });
const seed = process.env.AMADEUS_SEED_B58;
const ecdsaKey = process.env.AGENT_ECDSA_PRIVATE_KEY as Hex | undefined;
if (!seed || !ecdsaKey) throw new Error('AMADEUS_SEED_B58 and AGENT_ECDSA_PRIVATE_KEY must be set (run pnpm keys:new)');

const bls = createBlsSigner(seed);
const identity = {
  amadeusAddress: bls.identity,
  blsPublicKeyUncompressed: bls.publicKeyUncompressed,
  blsPublicKeyCompressed: bls.publicKeyCompressed,
  blsDst: stringToHex(INTENT_DST),
  ecdsaSigner: privateKeyToAccount(ecdsaKey).address,
};
const dir = resolve(import.meta.dirname, '../../deployments');
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'agent-identity.json'), `${JSON.stringify(identity, null, 2)}\n`);
console.log(`agent identity written (Amadeus ${identity.amadeusAddress})`);

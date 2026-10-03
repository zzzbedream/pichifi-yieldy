import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { generateKeypair } from '@amadeus-protocol/sdk';
import { intentDigest, type RebalanceIntent } from '../src/intent/eip712.js';
import { encodeFp, hashToFieldFp2, verifyDigest } from '../src/amadeus/bls.js';
import { createBlsSigner, createEcdsaSigner } from '../src/signing/signer.js';
import { recoverAddress } from 'viem';

const eip712 = JSON.parse(readFileSync(new URL('./fixtures/eip712-vector.json', import.meta.url), 'utf8')) as {
  chainId: number;
  digest: Hex;
  intent: Omit<RebalanceIntent, 'nonce' | 'deadline'> & { nonce: string; deadline: string; vault: Address };
};
const bls = JSON.parse(readFileSync(new URL('./fixtures/bls-vectors.json', import.meta.url), 'utf8')) as Record<string, string>;

describe('EIP-712 intent digest', () => {
  it('matches the fixture consumed by the Rust vault tests', () => {
    const intent: RebalanceIntent = {
      ...eip712.intent,
      nonce: BigInt(eip712.intent.nonce),
      deadline: BigInt(eip712.intent.deadline),
    };
    expect(intentDigest(eip712.chainId, intent)).toBe(eip712.digest);
  });
});

describe('Amadeus BLS signer', () => {
  it('signs digests that verify under the Amadeus public key and intent DST', async () => {
    const { privateKey } = generateKeypair();
    const signer = createBlsSigner(privateKey);
    const digest = keccak256(toHex('intent'));
    const signed = await signer.sign(digest);
    expect(signed.scheme).toBe('bls');
    expect(signed.signature.length).toBe(2 + 256 * 2);
    expect(signed.proof.length).toBe(2 + 96 * 2);
    expect(verifyDigest(digest, signed.proof, Uint8Array.from(Buffer.from(signer.publicKeyCompressed.slice(2), 'hex')))).toBe(true);
    expect(verifyDigest(keccak256(toHex('other')), signed.proof, Uint8Array.from(Buffer.from(signer.publicKeyCompressed.slice(2), 'hex')))).toBe(false);
    expect(signer.publicKeyUncompressed.length).toBe(2 + 128 * 2);
  });

  it('reproduces the hash_to_field vector used on-chain', () => {
    const [u0, u1] = hashToFieldFp2(Uint8Array.from(Buffer.from(bls.digest!.slice(2), 'hex')));
    expect(toHex(u0!)).toBe(bls.u0);
    expect(toHex(u1!)).toBe(bls.u1);
  });

  it('rejects out-of-range field elements', () => {
    expect(() => encodeFp(1n << 400n)).toThrow('out of range');
  });
});

describe('ECDSA fallback signer', () => {
  it('produces signatures recoverable to the signer address', async () => {
    const signer = createEcdsaSigner('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const digest = keccak256(toHex('intent'));
    const signed = await signer.sign(digest);
    expect(await recoverAddress({ hash: digest, signature: signed.signature })).toBe(signer.identity);
  });
});

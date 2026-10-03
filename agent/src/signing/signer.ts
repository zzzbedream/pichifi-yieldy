/**
 * Intent signers. The vault's verifier decides which scheme is accepted on-chain:
 * - `bls`  : Amadeus-native BLS12-381 (AmadeusBlsVerifier) — the primary path.
 * - `ecdsa`: secp256k1 fallback (EcdsaVerifier) behind the same `verify(bytes32,bytes)` ABI.
 */
import { privateKeyToAccount } from 'viem/accounts';
import { bytesToHex, type Hex } from 'viem';
import { fromBase58, toBase58 } from '@amadeus-protocol/sdk';
import { keypairFromSeed64, signDigest, publicKeyUncompressed } from '../amadeus/bls.js';

export interface SignedDigest {
  scheme: 'bls' | 'ecdsa';
  /** Bytes passed to `executeIntent(..., signature)`. */
  signature: Hex;
  /** Human-facing proof: compressed BLS signature or the ECDSA signature itself. */
  proof: Hex;
}

export interface IntentSigner {
  readonly scheme: 'bls' | 'ecdsa';
  /** Identity shown in the dashboard (Amadeus Base58 address or EVM address). */
  readonly identity: string;
  sign(digest: Hex): Promise<SignedDigest>;
}

export function createBlsSigner(seedB58: string): IntentSigner & { publicKeyUncompressed: Hex; publicKeyCompressed: Hex } {
  const { publicKey, secretKey } = keypairFromSeed64(fromBase58(seedB58));
  return {
    scheme: 'bls',
    identity: toBase58(publicKey),
    publicKeyUncompressed: publicKeyUncompressed(publicKey),
    publicKeyCompressed: bytesToHex(publicKey),
    async sign(digest) {
      const sig = signDigest(digest, secretKey);
      return { scheme: 'bls', signature: sig.uncompressed, proof: sig.compressed };
    },
  };
}

export function createEcdsaSigner(privateKey: Hex): IntentSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    scheme: 'ecdsa',
    identity: account.address,
    async sign(digest) {
      const signature = await account.sign({ hash: digest });
      return { scheme: 'ecdsa', signature, proof: signature };
    },
  };
}

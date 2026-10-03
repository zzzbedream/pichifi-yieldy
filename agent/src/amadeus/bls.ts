/**
 * Amadeus-native BLS12-381 signing for vault intents.
 *
 * Amadeus accounts are BLS12-381 "min_pk" keys (48-byte G1 public key, 96-byte G2
 * signature) derived from a 64-byte seed, exactly as in `@amadeus-protocol/sdk`.
 * We sign the 32-byte EIP-712 intent digest with the same key, under a dedicated
 * domain-separation tag so an intent signature can never be replayed as an
 * Amadeus transaction signature (and vice versa).
 *
 * The on-chain verifier (Stylus, EIP-2537 precompiles) consumes uncompressed points,
 * so this module also exposes the EIP-2537 encodings.
 */
import { bls12_381 } from '@noble/curves/bls12-381';
import { hash_to_field } from '@noble/curves/abstract/hash-to-curve';
import { sha256 } from '@noble/hashes/sha2';
import { seed64ToKeypair } from '@amadeus-protocol/sdk';
import { bytesToHex, hexToBytes, type Hex } from 'viem';

export const INTENT_DST = 'AMADEUS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_AYV_INTENT_';

const sigs = bls12_381.longSignatures;
const Fp = bls12_381.fields.Fp;

type G1Point = ReturnType<typeof sigs.getPublicKey>;
type G2Point = ReturnType<typeof sigs.hash>;

export interface AmadeusKeypair {
  /** Compressed G1 public key (48 bytes) — the Amadeus account address bytes. */
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function keypairFromSeed64(seed64: Uint8Array): AmadeusKeypair {
  if (seed64.length !== 64) throw new Error('Amadeus seed must be 64 bytes');
  const [publicKey, secretKey] = seed64ToKeypair(seed64) as [Uint8Array, Uint8Array];
  return { publicKey, secretKey };
}

/** EIP-2537 Fp encoding: 64 bytes, big-endian, top 16 bytes zero. */
export function encodeFp(value: bigint): Uint8Array {
  const out = new Uint8Array(64);
  let v = value;
  for (let i = 63; i >= 16; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error('Fp element out of range');
  return out;
}

export function encodeFp2(value: { c0: bigint; c1: bigint }): Uint8Array {
  return concat(encodeFp(value.c0), encodeFp(value.c1));
}

/** EIP-2537 G1 encoding (128 bytes): x || y. */
export function encodeG1(point: G1Point): Uint8Array {
  const { x, y } = point.toAffine();
  return concat(encodeFp(x), encodeFp(y));
}

/** EIP-2537 G2 encoding (256 bytes): x.c0 || x.c1 || y.c0 || y.c1. */
export function encodeG2(point: G2Point): Uint8Array {
  const { x, y } = point.toAffine();
  return concat(encodeFp2(x), encodeFp2(y));
}

export function publicKeyPoint(compressed: Uint8Array): G1Point {
  return bls12_381.G1.Point.fromBytes(compressed);
}

export function hashToG2(message: Uint8Array, dst: string = INTENT_DST): G2Point {
  return sigs.hash(message, dst);
}

/** RFC 9380 hash_to_field for G2 (count = 2, m = 2), as done on-chain before MAP_FP2_TO_G2. */
export function hashToFieldFp2(message: Uint8Array, dst: string = INTENT_DST): Uint8Array[] {
  const elements = hash_to_field(message, 2, {
    DST: dst,
    p: Fp.ORDER,
    m: 2,
    k: 128,
    expand: 'xmd',
    hash: sha256,
  });
  return elements.map(([c0, c1]) => encodeFp2({ c0: c0!, c1: c1! }));
}

export interface IntentSignature {
  /** Compressed G2 signature (96 bytes) — the Amadeus-native form. */
  compressed: Hex;
  /** Uncompressed EIP-2537 G2 signature (256 bytes) — what the vault verifies. */
  uncompressed: Hex;
}

export function signDigest(digest: Hex, secretKey: Uint8Array, dst: string = INTENT_DST): IntentSignature {
  const message = hexToBytes(digest);
  const signature = sigs.sign(hashToG2(message, dst), secretKey);
  return {
    compressed: bytesToHex(signature.toBytes(true)),
    uncompressed: bytesToHex(encodeG2(signature)),
  };
}

export function verifyDigest(
  digest: Hex,
  signatureCompressed: Hex,
  publicKey: Uint8Array,
  dst: string = INTENT_DST,
): boolean {
  return sigs.verify(hexToBytes(signatureCompressed), hashToG2(hexToBytes(digest), dst), publicKey);
}

/** Uncompressed EIP-2537 public key the vault's verifier is configured with. */
export function publicKeyUncompressed(publicKey: Uint8Array): Hex {
  return bytesToHex(encodeG1(publicKeyPoint(publicKey)));
}

/** -G1 generator, the fixed first pairing operand: e(-G1, sig) * e(pk, H(m)) == 1. */
export function negG1Generator(): Uint8Array {
  return encodeG1(bls12_381.G1.Point.BASE.negate());
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

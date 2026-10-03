/**
 * Audit anchor on Amadeus: every executed intent is minted as a token of a soulbound
 * collection owned by the agent, signed by the same Amadeus key that signed the intent.
 * The Amadeus explorer then shows a tamper-evident, timestamped log of every decision.
 *
 * Best-effort by design: an anchor failure is logged and surfaced in the dashboard but
 * never blocks the on-chain rebalance.
 */
import {
  AmadeusSDK,
  NETWORK_CONFIGS,
  NetworkType,
  buildNftCreateCollection,
  buildNftMint,
  deriveSkAndSeed64FromBase58Seed,
  getPublicKey,
  signContractCall,
  toBase58,
} from '@amadeus-protocol/sdk';
import type { Hex } from 'viem';
import type { Logger } from '../log.js';

export const ANCHOR_COLLECTION = 'AYVINTENTS';

export interface AnchorResult {
  txHash: string;
  explorerUrl: string;
}

export interface Anchorer {
  anchor(nonce: bigint, digest: Hex): Promise<AnchorResult | null>;
}

/** Token id: nonce + first 16 hex chars of the digest (short, unique per vault). */
export function anchorTokenId(nonce: bigint, digest: Hex): string {
  return `n${nonce.toString()}x${digest.slice(2, 18)}`;
}

export function createAmadeusAnchorer(seedB58: string, network: 'testnet' | 'mainnet', log: Logger): Anchorer {
  const networkType = network === 'mainnet' ? NetworkType.MAINNET : NetworkType.TESTNET;
  const config = NETWORK_CONFIGS[networkType];
  const sdk = new AmadeusSDK({ baseUrl: config.rpcUrl, timeout: 20_000 });
  const { seed64 } = deriveSkAndSeed64FromBase58Seed(seedB58);
  const owner = toBase58(getPublicKey(seed64));
  let collectionReady = false;

  async function submit(call: Parameters<typeof signContractCall>[1]): Promise<string> {
    const { txPacked } = signContractCall(seedB58, call, networkType);
    const result = await sdk.transaction.submitAndWait(txPacked);
    return result.hash;
  }

  async function ensureCollection(): Promise<void> {
    if (collectionReady) return;
    try {
      await submit(buildNftCreateCollection({ collection: ANCHOR_COLLECTION, soulbound: true }));
    } catch (err) {
      // Already created on a previous run — expected after the first boot.
      log.debug({ err }, 'anchor collection create skipped');
    }
    collectionReady = true;
  }

  return {
    async anchor(nonce, digest) {
      try {
        await ensureCollection();
        const txHash = await submit(
          buildNftMint({ recipient: owner, amount: 1, collection: ANCHOR_COLLECTION, token: anchorTokenId(nonce, digest) }),
        );
        return { txHash, explorerUrl: `${config.explorerUrl}/tx/${txHash}` };
      } catch (err) {
        log.warn({ err, nonce: nonce.toString() }, 'amadeus anchor failed (non-blocking)');
        return null;
      }
    },
  };
}

export const noopAnchorer: Anchorer = {
  async anchor() {
    return null;
  },
};

/**
 * EIP-712 typed data for `RebalanceIntent`. Must stay byte-identical to the vault's
 * Rust implementation (contracts/stylus/vault/src/eip712.rs); a shared fixture tests parity.
 */
import { hashTypedData, type Address, type Hex } from 'viem';

export const DOMAIN_NAME = 'AgenticYieldVault';
export const DOMAIN_VERSION = '1';

export const REGIME = { RISK_ON: 0, VOLATILE: 1, RISK_OFF: 2 } as const;
export type Regime = (typeof REGIME)[keyof typeof REGIME];

export const intentTypes = {
  RebalanceIntent: [
    { name: 'vault', type: 'address' },
    { name: 'nonce', type: 'uint64' },
    { name: 'deadline', type: 'uint64' },
    { name: 'regime', type: 'uint8' },
    { name: 'morphoBps', type: 'uint16' },
    { name: 'uniswapBps', type: 'uint16' },
    { name: 'volBps', type: 'uint16' },
    { name: 'inputsHash', type: 'bytes32' },
    { name: 'modelVersion', type: 'bytes32' },
  ],
} as const;

export interface RebalanceIntent {
  vault: Address;
  nonce: bigint;
  deadline: bigint;
  regime: Regime;
  morphoBps: number;
  uniswapBps: number;
  volBps: number;
  inputsHash: Hex;
  modelVersion: Hex;
}

export function intentDigest(chainId: number, intent: RebalanceIntent): Hex {
  return hashTypedData({
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: intent.vault },
    types: intentTypes,
    primaryType: 'RebalanceIntent',
    message: intent,
  });
}

/**
 * Reads vault state and relays signed intents. Relaying needs no special permission:
 * the vault only trusts the signature, so the relayer key just pays gas.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  decodeErrorResult,
  encodeFunctionData,
  createWalletClient,
  defineChain,
  http,
  webSocket,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { vaultAbi } from './vaultAbi.js';
import type { RebalanceIntent } from '../intent/eip712.js';
import type { Config } from '../config.js';

export interface VaultSnapshot {
  nonce: bigint;
  totalAssets: bigint;
  idle: bigint;
  morpho: bigint;
  uniswap: bigint;
  regime: number;
  morphoBps: number;
  uniswapBps: number;
  lastRebalance: bigint;
  minRebalanceInterval: bigint;
  paused: boolean;
}

/** Vault errors that clear up by themselves; the agent retries instead of reporting them. */
export const RETRYABLE_ERRORS = new Set(['RebalanceTooSoon']);

export type Preflight = { ok: true } | { ok: false; errorName: string; message: string; retryable: boolean };

/** Gas limit for `executeIntent` (BLS verify + Morpho + v4 unwind/deploy, plus L1 data). */
export const EXECUTE_INTENT_GAS = 6_000_000n;

/** Extracts the custom-error name from a viem error (decoded or raw revert data). */
export function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) return reverted.data.errorName;
  const withData = err.walk((e) => typeof (e as { data?: unknown }).data === 'string');
  const data = (withData as { data?: string } | null)?.data;
  if (!data?.startsWith('0x') || data.length < 10) return undefined;
  try {
    return decodeErrorResult({ abi: vaultAbi, data: data as Hex }).errorName;
  } catch {
    return undefined;
  }
}

export interface VaultClient {
  readonly address: Address;
  readonly chainId: number;
  readonly publicClient: PublicClient;
  snapshot(): Promise<VaultSnapshot>;
  onChainDigest(intent: RebalanceIntent): Promise<Hex>;
  /** Dry-runs `executeIntent` — the chain, not a local clock, decides if it would pass. */
  preflight(intent: RebalanceIntent, signature: Hex): Promise<Preflight>;
  relay(intent: RebalanceIntent, signature: Hex): Promise<{ txHash: Hex; blockNumber: bigint; status: 'success' | 'reverted' }>;
  now(): Promise<bigint>;
}

function intentArgs(i: RebalanceIntent, signature: Hex) {
  return [i.nonce, i.deadline, i.regime, i.morphoBps, i.uniswapBps, i.volBps, i.inputsHash, i.modelVersion, signature] as const;
}

export function robinhoodChain(config: Pick<Config, 'CHAIN_ID' | 'RPC_URL' | 'EXPLORER_URL'>) {
  return defineChain({
    id: config.CHAIN_ID,
    name: config.CHAIN_ID === 4663 ? 'Robinhood Chain' : 'Robinhood Chain Testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.RPC_URL] } },
    blockExplorers: { default: { name: 'Blockscout', url: config.EXPLORER_URL } },
  });
}

export function createVaultClient(config: Config): VaultClient {
  const chain = robinhoodChain(config);
  const transport = config.WSS_URL ? webSocket(config.WSS_URL) : http(config.RPC_URL);
  const publicClient = createPublicClient({ chain, transport }) as PublicClient;
  const account = privateKeyToAccount(config.RELAYER_PRIVATE_KEY);
  const walletClient = createWalletClient({ chain, transport: http(config.RPC_URL), account });
  const address = config.VAULT_ADDRESS;
  const read = { address, abi: vaultAbi } as const;

  return {
    address,
    chainId: config.CHAIN_ID,
    publicClient,

    async snapshot() {
      const [nonce, totalAssets, allocation, agentState, guardrails, paused] = await Promise.all([
        publicClient.readContract({ ...read, functionName: 'nonce' }),
        publicClient.readContract({ ...read, functionName: 'totalAssets' }),
        publicClient.readContract({ ...read, functionName: 'allocation' }),
        publicClient.readContract({ ...read, functionName: 'agentState' }),
        publicClient.readContract({ ...read, functionName: 'guardrails' }),
        publicClient.readContract({ ...read, functionName: 'paused' }),
      ]);
      return {
        nonce,
        totalAssets,
        idle: allocation[0],
        morpho: allocation[1],
        uniswap: allocation[2],
        regime: agentState[0],
        morphoBps: agentState[1],
        uniswapBps: agentState[2],
        lastRebalance: agentState[3],
        minRebalanceInterval: guardrails[1],
        paused,
      };
    },

    async onChainDigest(i) {
      return publicClient.readContract({
        ...read,
        functionName: 'intentDigest',
        args: [i.nonce, i.deadline, i.regime, i.morphoBps, i.uniswapBps, i.volBps, i.inputsHash, i.modelVersion],
      });
    },

    // Simulated at the current time: on quiet chains the latest block's timestamp is stale,
    // while the real transaction lands in a fresh block.
    async preflight(i, signature) {
      try {
        const time = await this.now();
        await publicClient.call({
          account,
          to: address,
          data: encodeFunctionData({ abi: vaultAbi, functionName: 'executeIntent', args: intentArgs(i, signature) }),
          blockOverrides: { time },
        });
        return { ok: true };
      } catch (err) {
        const errorName = revertName(err) ?? 'Unknown';
        const message = err instanceof BaseError ? err.shortMessage : String(err);
        return { ok: false, errorName, message, retryable: RETRYABLE_ERRORS.has(errorName) };
      }
    },

    // Preflight already simulated at the current time; an explicit gas limit skips
    // eth_estimateGas, which would evaluate against the stale latest block.
    async relay(i, signature) {
      const txHash = await walletClient.writeContract({
        ...read,
        functionName: 'executeIntent',
        args: intentArgs(i, signature),
        gas: EXECUTE_INTENT_GAS,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      return { txHash, blockNumber: receipt.blockNumber, status: receipt.status };
    },

    /**
     * Chains that only produce blocks on demand (Arbitrum Orbit testnets, anvil) freeze the
     * latest block timestamp while idle; the next block takes the current time, so scheduling
     * uses whichever is later.
     */
    async now() {
      const block = await publicClient.getBlock();
      const wall = BigInt(Math.floor(Date.now() / 1000));
      return block.timestamp > wall ? block.timestamp : wall;
    },
  };
}

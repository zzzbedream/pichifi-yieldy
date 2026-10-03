/**
 * Reads vault state and relays signed intents. Relaying needs no special permission:
 * the vault only trusts the signature, so the relayer key just pays gas.
 */
import {
  createPublicClient,
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

export interface VaultClient {
  readonly address: Address;
  readonly chainId: number;
  readonly publicClient: PublicClient;
  snapshot(): Promise<VaultSnapshot>;
  onChainDigest(intent: RebalanceIntent): Promise<Hex>;
  relay(intent: RebalanceIntent, signature: Hex): Promise<{ txHash: Hex; blockNumber: bigint; status: 'success' | 'reverted' }>;
  now(): Promise<bigint>;
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

    async relay(i, signature) {
      const args = [i.nonce, i.deadline, i.regime, i.morphoBps, i.uniswapBps, i.volBps, i.inputsHash, i.modelVersion, signature] as const;
      const { request } = await publicClient.simulateContract({ ...read, functionName: 'executeIntent', args, account });
      const txHash = await walletClient.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      return { txHash, blockNumber: receipt.blockNumber, status: receipt.status };
    },

    async now() {
      const block = await publicClient.getBlock();
      return block.timestamp;
    },
  };
}

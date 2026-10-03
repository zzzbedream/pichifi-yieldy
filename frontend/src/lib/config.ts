import { defineChain, isAddress, type Address } from 'viem';

function addr(value: string | undefined): Address | undefined {
  return value && isAddress(value) ? (value as Address) : undefined;
}

// NEXT_PUBLIC_* values are inlined at build time, so they must be referenced literally.
export const appConfig = {
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 46630),
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com',
  explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL ?? 'https://explorer.testnet.chain.robinhood.com',
  agentApiUrl: process.env.NEXT_PUBLIC_AGENT_API_URL ?? 'http://localhost:8787',
  build: process.env.NEXT_PUBLIC_VAULT_BUILD ?? 'solidity',
  demoMode: process.env.NEXT_PUBLIC_DEMO === '1',
  contracts: {
    vault: addr(process.env.NEXT_PUBLIC_VAULT_ADDRESS),
    feeEngine: addr(process.env.NEXT_PUBLIC_FEE_ENGINE_ADDRESS),
    verifier: addr(process.env.NEXT_PUBLIC_VERIFIER_ADDRESS),
    adapter: addr(process.env.NEXT_PUBLIC_ADAPTER_ADDRESS),
    hook: addr(process.env.NEXT_PUBLIC_HOOK_ADDRESS),
    usdg: addr(process.env.NEXT_PUBLIC_USDG_ADDRESS),
    stock: addr(process.env.NEXT_PUBLIC_STOCK_TOKEN_ADDRESS),
    morpho: addr(process.env.NEXT_PUBLIC_MORPHO_ADDRESS),
    irm: addr(process.env.NEXT_PUBLIC_IRM_ADDRESS),
  },
  marketId: process.env.NEXT_PUBLIC_MARKET_ID as `0x${string}` | undefined,
} as const;

export const robinhoodTestnet = defineChain({
  id: appConfig.chainId,
  name: appConfig.chainId === 4663 ? 'Robinhood Chain' : 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [appConfig.rpcUrl] } },
  blockExplorers: { default: { name: 'Blockscout', url: appConfig.explorerUrl } },
  testnet: appConfig.chainId !== 4663,
});

export const isConfigured = Boolean(appConfig.contracts.vault && appConfig.contracts.usdg);

export function explorerAddress(address: string): string {
  return `${appConfig.explorerUrl}/address/${address}`;
}

export function explorerTx(hash: string): string {
  return `${appConfig.explorerUrl}/tx/${hash}`;
}

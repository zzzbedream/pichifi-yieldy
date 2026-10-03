'use client';

import { useReadContracts } from 'wagmi';
import type { Address } from 'viem';
import { appConfig } from '@/lib/config';
import { erc20Abi, feeEngineAbi, irmAbi, morphoAbi, vaultAbi } from '@/lib/abis';

const POLL_MS = 2_000;
const WAD = 10n ** 18n;

/** Vault, fee engine and Morpho market state, polled every 2s (Robinhood blocks ~100-200ms). */
export function useVaultData() {
  const { vault, feeEngine, morpho } = appConfig.contracts;
  const enabled = Boolean(vault);
  const v = { address: vault as Address, abi: vaultAbi } as const;

  const result = useReadContracts({
    allowFailure: true,
    query: { enabled, refetchInterval: POLL_MS },
    contracts: [
      { ...v, functionName: 'totalAssets' },
      { ...v, functionName: 'totalSupply' },
      { ...v, functionName: 'allocation' },
      { ...v, functionName: 'agentState' },
      { ...v, functionName: 'paused' },
      { address: feeEngine as Address, abi: feeEngineAbi, functionName: 'currentFeePips' },
      { address: morpho as Address, abi: morphoAbi, functionName: 'market', args: [appConfig.marketId ?? '0x'] },
    ],
  });

  const [totalAssets, totalSupply, allocation, agentState, paused, feePips, market] = result.data ?? [];
  const marketData = market?.result;
  const utilization =
    marketData && marketData[0] > 0n ? (BigInt(marketData[2]) * WAD) / BigInt(marketData[0]) : undefined;

  const apr = useReadContracts({
    query: { enabled: Boolean(appConfig.contracts.irm && utilization !== undefined), refetchInterval: 15_000 },
    contracts: [
      { address: appConfig.contracts.irm as Address, abi: irmAbi, functionName: 'aprAt', args: [utilization ?? 0n] },
    ],
  });
  const borrowApr = apr.data?.[0]?.result;
  const feeShare = marketData ? BigInt(marketData[5]) : 0n;
  const supplyApr =
    borrowApr !== undefined && utilization !== undefined
      ? (((borrowApr * utilization) / WAD) * (WAD - feeShare)) / WAD
      : undefined;

  const assets = totalAssets?.result;
  const supply = totalSupply?.result;
  // 1 share unit = 1e-12 (6 USDG decimals + 6 virtual offset); price per 1e6 share units.
  const sharePrice = assets !== undefined && supply ? (assets * 10n ** 12n) / supply : undefined;

  return {
    enabled,
    isLoading: result.isLoading,
    totalAssets: assets,
    totalSupply: supply,
    sharePrice,
    allocation: allocation?.result,
    agentState: agentState?.result,
    paused: paused?.result,
    feePips: feePips?.result,
    utilization,
    supplyApr,
    refetch: result.refetch,
  };
}

/** Connected wallet's USDG + share balances and allowance. */
export function useWalletData(account: Address | undefined) {
  const { vault, usdg } = appConfig.contracts;
  const enabled = Boolean(account && vault && usdg);
  const result = useReadContracts({
    allowFailure: true,
    query: { enabled, refetchInterval: POLL_MS },
    contracts: [
      { address: usdg as Address, abi: erc20Abi, functionName: 'balanceOf', args: [account as Address] },
      { address: usdg as Address, abi: erc20Abi, functionName: 'allowance', args: [account as Address, vault as Address] },
      { address: vault as Address, abi: vaultAbi, functionName: 'balanceOf', args: [account as Address] },
      { address: usdg as Address, abi: erc20Abi, functionName: 'faucetCap' },
    ],
  });
  const [usdgBalance, allowance, shares, faucetCap] = result.data ?? [];
  return {
    usdgBalance: usdgBalance?.result,
    allowance: allowance?.result,
    shares: shares?.result,
    faucetCap: faucetCap?.result,
    refetch: result.refetch,
  };
}

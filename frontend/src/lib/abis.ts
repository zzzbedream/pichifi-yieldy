import { parseAbi } from 'viem';

/** Shared by the Rust/Stylus vault and its ABI-identical Solidity build. */
export const vaultAbi = parseAbi([
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allocation() view returns (uint256 idle, uint256 morpho, uint256 uniswap)',
  'function agentState() view returns (uint8 regime, uint16 morphoBps, uint16 uniswapBps, uint64 lastRebalance, bytes32 lastInputsHash)',
  'function nonce() view returns (uint64)',
  'function paused() view returns (bool)',
  'function previewRedeem(uint256 shares) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function deposit(uint256 assets, address receiver) returns (uint256)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256)',
  'event IntentExecuted(uint64 indexed nonce, uint8 regime, uint16 morphoBps, uint16 uniswapBps, uint16 volBps, bytes32 inputsHash, bytes32 modelVersion, bytes32 digest)',
  'event Rebalanced(uint256 idle, uint256 morpho, uint256 uniswap, uint256 navBefore, uint256 navAfter)',
]);

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function faucet(uint256 amount)',
  'function faucetCap() view returns (uint256)',
]);

export const feeEngineAbi = parseAbi([
  'function currentFeePips() view returns (uint32)',
  'function regime() view returns (uint8)',
  'function volBps() view returns (uint16)',
]);

export const morphoAbi = parseAbi([
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
]);

export const irmAbi = parseAbi(['function aprAt(uint256 utilization) view returns (uint256)']);

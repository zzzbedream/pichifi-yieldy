/** ABI subset shared by the Rust/Stylus vault and its ABI-identical Solidity build. */
import { parseAbi } from 'viem';

export const vaultAbi = parseAbi([
  'function nonce() view returns (uint64)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function allocation() view returns (uint256 idle, uint256 morpho, uint256 uniswap)',
  'function agentState() view returns (uint8 regime, uint16 morphoBps, uint16 uniswapBps, uint64 lastRebalance, bytes32 lastInputsHash)',
  'function guardrails() view returns (uint16 maxUniswapBps, uint64 minRebalanceInterval, uint16 maxNavLossBps, uint256 minMove)',
  'function paused() view returns (bool)',
  'function intentDigest(uint64 nonce, uint64 deadline, uint8 regime, uint16 morphoBps, uint16 uniswapBps, uint16 volBps, bytes32 inputsHash, bytes32 modelVersion) view returns (bytes32)',
  'function executeIntent(uint64 nonce, uint64 deadline, uint8 regime, uint16 morphoBps, uint16 uniswapBps, uint16 volBps, bytes32 inputsHash, bytes32 modelVersion, bytes signature)',
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
  'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)',
  'event IntentExecuted(uint64 indexed nonce, uint8 regime, uint16 morphoBps, uint16 uniswapBps, uint16 volBps, bytes32 inputsHash, bytes32 modelVersion, bytes32 digest)',
  'event Rebalanced(uint256 idle, uint256 morpho, uint256 uniswap, uint256 navBefore, uint256 navAfter)',
]);

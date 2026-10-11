/** Landing copy. Every claim here must match the README "real vs simulated" table. */

export const REPO_URL = 'https://github.com/zzzbedream/pichifi-yieldy';
export const VAULT_EXPLORER_URL =
  'https://explorer.testnet.chain.robinhood.com/address/0x60690F414006008984801DBc550C1348B256820f';
export const FIRST_ANCHOR_URL = 'https://explorer.ama.one/tx/5tkH5CwpszndcvFZi3ABW6WLNfHt87XoFuiQm338nWMD';

export const PILLARS = [
  {
    tag: '01 · Verifiable agent',
    title: 'An AI allocator that has to prove every move',
    body: 'A deterministic policy turns market inputs into a signed intent. The agent signs it with its Amadeus BLS12-381 key, and the vault verifies that signature on-chain before a single dollar moves.',
  },
  {
    tag: '02 · Protected liquidity',
    title: 'Uniswap v4 liquidity that charges for volatility',
    body: 'A dynamic-fee hook raises the swap fee when the agent expects volatility, so arbitrageurs pay for the loss-versus-rebalancing they cause instead of our liquidity providers.',
  },
  {
    tag: '03 · Safe harbour',
    title: 'Borrower-paid yield on Morpho Blue',
    body: 'When risk rises, capital moves to an isolated Morpho Blue USDG market. The yield comes from borrowers, not from the stablecoin issuer.',
  },
] as const;

export const PROBLEMS = [
  {
    figure: '24/7',
    title: 'Tokenized stocks never close. Their liquidity providers get picked off.',
    body: 'Most tokenized-stock trading happens outside US market hours, when the AMM is the only price. Loss-versus-rebalancing means arbitrageurs extract more than LPs earn in fees in many pools, and a static fee does not react to an earnings week.',
    source: { label: 'Milionis et al., LVR (2022)', href: 'https://arxiv.org/abs/2208.06046' },
  },
  {
    figure: '1',
    title: 'Idle USDG has one default destination.',
    body: 'Holders can lend, or provide unprotected liquidity. Nothing switches between the two by market regime, and nobody does it on their behalf around the clock.',
    source: { label: 'Robinhood Earn on Morpho', href: 'https://morpho.org/blog/robinhood-chooses-morpho-to-power-new-earn-product' },
  },
  {
    figure: '?',
    title: 'AI agents managing money are a black box.',
    body: 'You usually cannot verify what an agent decided, from which inputs, or whether the contract actually checked it. So capital stays with human curators.',
    source: undefined,
  },
] as const;

export const STEPS = [
  { n: '1', title: 'Deposit USDG', body: 'Investors deposit USDG and receive ayvUSDG vault shares (ERC-4626-style accounting).' },
  { n: '2', title: 'The agent decides', body: 'A pure, deterministic policy classifies the market into a regime and a target allocation. Same inputs, same intent.' },
  { n: '3', title: 'Signed with Amadeus', body: 'The EIP-712 intent, bound to this vault and chain, is signed with the agent’s Amadeus BLS12-381 key.' },
  { n: '4', title: 'Verified on-chain', body: 'The vault checks nonce, deadline and the BLS signature with Robinhood Chain’s EIP-2537 precompiles, then the guardrails.' },
  { n: '5', title: 'Rebalance and anchor', body: 'Funds move between Uniswap v4 and Morpho, the hook fee updates, and the decision is anchored on Amadeus mainnet.' },
] as const;

export const REGIMES = [
  { key: 'on', name: 'Risk on', trigger: 'Calm market', alloc: '50% Morpho · 50% LP', fee: '0.30%' },
  { key: 'volatile', name: 'Volatile', trigger: 'Earnings within 2 days, implied vol ≥ 60%', alloc: '70% Morpho · 30% LP', fee: '0.30% + 2 pips per bps of vol' },
  { key: 'off', name: 'Risk off', trigger: 'Recession signal or crash momentum', alloc: '100% Morpho · 0% LP', fee: '5.00%' },
] as const;

export const GUARANTEES = [
  'No signature, no movement: funds move only through a verified, in-order, unexpired intent.',
  'Whitelisted destinations only: the configured Uniswap v4 adapter and Morpho market.',
  'LP leg capped at 70%, none in risk-off, 30 s minimum between rebalances, max 3% NAV loss per rebalance.',
  'Pool price must stay within 10% of the oracle before any LP action.',
  'A guardian can pause and run an emergency exit back to idle USDG.',
  'Exits never depend on the agent: redemptions work while paused or with the agent offline.',
] as const;

export const PROOF = [
  { figure: '13', label: 'contracts verified on Blockscout', href: VAULT_EXPLORER_URL },
  { figure: '10/10', label: 'end-to-end checks on live testnet', href: REPO_URL },
  { figure: '25/25', label: 'invariant QA checks, live', href: REPO_URL },
  { figure: 'Live', label: 'decisions anchored on Amadeus mainnet', href: FIRST_ANCHOR_URL },
] as const;

export const ROADMAP = [
  {
    phase: 'Now',
    status: 'live',
    items: [
      'USDG vault live on Robinhood Chain testnet',
      'On-chain BLS verification of every agent decision',
      'Dynamic-fee Uniswap v4 hook + Morpho Blue safe harbour',
      'Decisions anchored on Amadeus mainnet',
      'Live market inputs: NVDA price, volatility, earnings calendar, recession probability',
      '$PICHI community token on vibe/vibe testnet',
    ],
  },
  {
    phase: 'Next',
    status: 'building',
    items: [
      'Switch the live vault to the canonical Rust/Stylus build when activations resume',
      'On-chain price oracles and a real implied-volatility feed',
      'External security audit',
    ],
  },
  {
    phase: 'Later',
    status: 'planned',
    items: [
      'Mainnet with official USDG and Robinhood Stock Tokens',
      'Agent execution inside a TEE with remote attestation',
      'Multi-agent BLS aggregation and a curated vault marketplace',
    ],
  },
] as const;

export const HONESTY = {
  real: 'Real: live market inputs (Yahoo Finance, Finnhub, FRED), on-chain BLS12-381 verification, Robinhood’s Uniswap v4 PoolManager with our hook, Morpho Blue, guardrails, Amadeus mainnet anchoring.',
  simulated: 'Simulated on testnet: the rhNVDA test stock and its oracle, test USDG, optional stress-test scenarios; implied vol uses realized vol as a proxy. Not audited; testnet tokens have no monetary value.',
} as const;

export const BUSINESS = [
  { figure: '0.5%', label: 'annual management fee on assets under management' },
  { figure: '10%', label: 'performance fee, only on returns above the Robinhood Earn benchmark (~7% APY), with a high-water mark' },
  { figure: '0%', label: 'deposit or withdrawal fees: investors only pay when the agent beats lending' },
] as const;

export const FAUCET_URL = 'https://faucet.testnet.chain.robinhood.com/';

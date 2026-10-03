# Agentic Yield Vaults — product instruction

This file tells any engineer or coding agent **what this product must do** and the rules the code must keep. Read it before changing anything.

## What the product is

An institutional, autonomous USDG asset manager on **Robinhood Chain** (Arbitrum Orbit L2, testnet chain id `46630`, mainnet `4663`).

- **Deposits.** Investors deposit **USDG** and receive `ayvUSDG` vault shares. Accounting is ERC-4626-style with a 6-decimal virtual offset.
- **Risk-on leg.** Liquidity in a **Uniswap v4** Stock Token/USDG pool. A **dynamic-fee hook** protects it: its fee logic lives in the Rust `FeeEngine`, and it raises swap fees when the agent expects volatility, so arbitrageurs pay for the loss-versus-rebalancing (LVR) they cause.
- **Safe-harbour leg.** Supply to an isolated **Morpho Blue** lending market. The yield comes from borrowers, not from the stablecoin issuer.
- **The brain.** An off-chain AI agent with an **Amadeus Protocol** identity runs a **deterministic** policy (same inputs → same intent). It signs every rebalancing intent with its Amadeus **BLS12-381** key.
- **The checks.** The vault verifies that signature **on-chain** (EIP-2537 precompiles) before moving any funds. A dashboard shows every decision with its proof.

## Invariants (the code must enforce these; tests must cover them)

1. **No signature, no movement.** Funds move only through `executeIntent`. It requires a valid signature from the configured verifier, the exact next `nonce`, a live `deadline`, and an EIP-712 domain bound to this vault and this chain.
2. **Whitelisted destinations only:** the configured Uniswap v4 adapter and the configured Morpho market.
3. **Guardrails:**
   - `uniswapBps ≤ maxUniswapBps`
   - `morphoBps + uniswapBps ≤ 10000`
   - no LP leg in `RISK_OFF`
   - a minimum interval between rebalances, measured with `block.timestamp` (on Arbitrum `block.number` is an L1 estimate)
   - a maximum NAV loss per rebalance
   - the pool price must stay within `maxDeviationBps` of the oracle before any LP action
4. **A guardian can pause** the vault and run `emergencyExit`, which brings every position back to idle USDG.
5. **Exits never depend on the agent.** Redemptions work while the vault is paused and while the agent is offline. Liquidity comes from idle first, then Morpho, then the LP leg. The redeemer bears their own unwind slippage, bounded by `maxNavLossBps`.
6. **No reentrancy surface.** The vault never receives callbacks. Uniswap's `unlockCallback` goes to the adapter.

## Repository map

| Path | What |
|---|---|
| `contracts/stylus/` | **Canonical** Rust/Stylus contracts (`stylus-sdk` 0.10.10, toolchain 1.91.0): `vault`, `fee-engine`, `bls-verifier`, `ecdsa-verifier`. Pure logic lives in `math.rs` / `eip712.rs` / `verify_signature` and is unit-tested. |
| `contracts/evm/` | Foundry project with the Solidity pieces: `DynamicFeeHook`, `UniV4LiquidityAdapter`, testnet mocks (`TestToken`, `StockPriceOracle`, `KinkIrm`), Morpho deployment, and `solidity-build/`, the **ABI-identical Solidity build** of the Stylus contracts. |
| `agent/` | TypeScript agent: deterministic policy, EIP-712 intents, Amadeus BLS signer, relayer, indexer and API (SSE). |
| `frontend/` | Next.js dashboard (wagmi/viem, injected wallets such as MetaMask and Rabby). |
| `deployments/` | Public contract addresses per network. Committed. |
| `postulacion/` | **Internal hackathon docs (Spanish). Gitignored. Never commit.** |

## Why there are two builds of the core contracts

On 2026-10-02 new Stylus **activations** were paused network-wide. `cargo stylus check` reports it on Robinhood testnet, Robinhood mainnet and Arbitrum Sepolia. The Rust contracts remain the source of truth. They are tested, and they run end-to-end on a local Nitro devnode.

The Solidity build in `contracts/evm/src/solidity-build/` has the **same ABI, events, errors and math**, and runs live on Robinhood testnet until activations resume. The agent and frontend select a build through config only. Any behavioural change must land in **both** builds, with the parity tests updated:
- EIP-712: `agent/scripts/eip712-vectors.ts`
- BLS: `agent/scripts/bls-vectors.ts`

## Conventions

- Code, comments, README and commits in **English**; internal docs (`postulacion/`) in **Spanish**.
- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).
- Never commit secrets. `.env*` is ignored; document every variable in `.env.example`.
- The agent policy must stay a **pure, deterministic function**. Fixed-point integers only, no wall-clock reads inside the policy. `inputsHash = keccak256(canonical JSON of inputs)`.
- Be honest about what is simulated, both in the README and in the UI: TEE, market-data scenarios, mock Stock Token and oracle on testnet.

## Commands

```bash
# Rust / Stylus (tests run natively on any OS)
cd contracts/stylus && cargo test --workspace
cargo build -p vault --lib --release --target wasm32-unknown-unknown
# cargo-stylus does not build on Windows: run it from WSL/Linux
cargo stylus check -e $RPC_URL        # inside a contract crate

# Solidity
cd contracts/evm && forge build && forge test -vvv

# Agent
cd agent && pnpm install && pnpm test
pnpm bls:vectors      # regenerates BLS fixtures and proves the pipeline on live precompiles

# Frontend
cd frontend && pnpm install && pnpm dev
```

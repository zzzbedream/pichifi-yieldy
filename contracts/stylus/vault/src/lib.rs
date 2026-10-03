//! AgenticVault — institutional USDG vault on Robinhood Chain, written in Rust for Stylus.
//!
//! Depositors receive `ayvUSDG` shares (ERC-20, ERC-4626-style accounting). The vault's
//! USDG is allocated between:
//! - a Uniswap v4 Stock Token/USDG LP position, held by a whitelisted adapter and protected
//!   by a dynamic-fee hook whose fee logic lives in the Rust `FeeEngine`; and
//! - a Morpho Blue lending market (the safe harbour), called directly from Rust.
//!
//! Funds only move through `execute_intent`, which requires a `RebalanceIntent` signed by
//! the agent's Amadeus key (BLS12-381, verified on-chain) with the exact next nonce, a live
//! deadline and allocations inside the guardrails. Deposits and redemptions never depend on
//! the agent being online.

#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

pub mod eip712;
pub mod interfaces;
pub mod math;

use alloc::{string::String, vec::Vec};
use alloy_primitives::{keccak256, Address, Bytes, B256, U16, U256, U64, U8};
use alloy_sol_types::{sol, SolCall, SolValue};
use eip712::RebalanceIntent;
use interfaces::{IFeeEngine, ILiquidityAdapter, IIntentVerifier, IMorpho, MarketParams, IERC20};
use math::{Holdings, BPS};
use stylus_sdk::{
    call::{call as call_contract, static_call},
    prelude::*,
    storage::{
        StorageAddress, StorageB256, StorageBool, StorageMap, StorageU16, StorageU256, StorageU64,
        StorageU8,
    },
};

pub const REGIME_RISK_ON: u8 = 0;
pub const REGIME_VOLATILE: u8 = 1;
pub const REGIME_RISK_OFF: u8 = 2;

sol! {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares);
    event IntentExecuted(uint64 indexed nonce, uint8 regime, uint16 morphoBps, uint16 uniswapBps, uint16 volBps, bytes32 inputsHash, bytes32 modelVersion, bytes32 digest);
    event Rebalanced(uint256 idle, uint256 morpho, uint256 uniswap, uint256 navBefore, uint256 navAfter);
    event GuardrailsUpdated(uint16 maxUniswapBps, uint64 minRebalanceInterval, uint16 maxNavLossBps, uint256 minMove);
    event VerifierChanged(address indexed previousVerifier, address indexed newVerifier);
    event AdapterSet(address indexed adapter);
    event GuardianChanged(address indexed previousGuardian, address indexed newGuardian);
    event PausedSet(bool paused);
    event EmergencyExit(uint256 idleAfter);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized(address caller);
    error ZeroAddress();
    error ZeroAmount();
    error Paused();
    error InsufficientBalance(uint256 have, uint256 want);
    error InsufficientAllowance(uint256 have, uint256 want);
    error InsufficientLiquidity(uint256 have, uint256 want);
    error InvalidNonce(uint64 expected, uint64 got);
    error IntentExpired(uint64 deadline, uint64 nowTs);
    error RebalanceTooSoon(uint64 nextAllowed);
    error InvalidAllocation(uint16 morphoBps, uint16 uniswapBps);
    error InvalidSignature();
    error AdapterNotSet();
    error AdapterAlreadySet();
    error NavLossExceeded(uint256 navBefore, uint256 navAfter);
    error ExternalCallFailed(address target);
}

#[derive(SolidityError)]
pub enum VaultError {
    Unauthorized(Unauthorized),
    ZeroAddress(ZeroAddress),
    ZeroAmount(ZeroAmount),
    Paused(Paused),
    InsufficientBalance(InsufficientBalance),
    InsufficientAllowance(InsufficientAllowance),
    InsufficientLiquidity(InsufficientLiquidity),
    InvalidNonce(InvalidNonce),
    IntentExpired(IntentExpired),
    RebalanceTooSoon(RebalanceTooSoon),
    InvalidAllocation(InvalidAllocation),
    InvalidSignature(InvalidSignature),
    AdapterNotSet(AdapterNotSet),
    AdapterAlreadySet(AdapterAlreadySet),
    NavLossExceeded(NavLossExceeded),
    ExternalCallFailed(ExternalCallFailed),
}

impl core::fmt::Debug for VaultError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let name = match self {
            Self::Unauthorized(_) => "Unauthorized",
            Self::ZeroAddress(_) => "ZeroAddress",
            Self::ZeroAmount(_) => "ZeroAmount",
            Self::Paused(_) => "Paused",
            Self::InsufficientBalance(_) => "InsufficientBalance",
            Self::InsufficientAllowance(_) => "InsufficientAllowance",
            Self::InsufficientLiquidity(_) => "InsufficientLiquidity",
            Self::InvalidNonce(_) => "InvalidNonce",
            Self::IntentExpired(_) => "IntentExpired",
            Self::RebalanceTooSoon(_) => "RebalanceTooSoon",
            Self::InvalidAllocation(_) => "InvalidAllocation",
            Self::InvalidSignature(_) => "InvalidSignature",
            Self::AdapterNotSet(_) => "AdapterNotSet",
            Self::AdapterAlreadySet(_) => "AdapterAlreadySet",
            Self::NavLossExceeded(_) => "NavLossExceeded",
            Self::ExternalCallFailed(_) => "ExternalCallFailed",
        };
        f.write_str(name)
    }
}

/// Validates an intent's allocation against the guardrails (pure, unit-tested).
pub fn validate_allocation(
    regime: u8,
    morpho_bps: u16,
    uniswap_bps: u16,
    max_uniswap_bps: u16,
) -> Result<(), VaultError> {
    let total = u32::from(morpho_bps) + u32::from(uniswap_bps);
    let risk_off_with_lp = regime == REGIME_RISK_OFF && uniswap_bps > 0;
    if regime > REGIME_RISK_OFF || total > BPS as u32 || uniswap_bps > max_uniswap_bps || risk_off_with_lp {
        return Err(VaultError::InvalidAllocation(InvalidAllocation {
            morphoBps: morpho_bps,
            uniswapBps: uniswap_bps,
        }));
    }
    Ok(())
}

#[storage]
#[entrypoint]
pub struct AgenticVault {
    // --- ERC-20 shares ---
    balances: StorageMap<Address, StorageU256>,
    allowances: StorageMap<Address, StorageMap<Address, StorageU256>>,
    total_supply: StorageU256,
    // --- roles & wiring ---
    owner: StorageAddress,
    guardian: StorageAddress,
    paused: StorageBool,
    asset: StorageAddress,
    verifier: StorageAddress,
    fee_engine: StorageAddress,
    adapter: StorageAddress,
    // --- Morpho Blue market (loan token = asset) ---
    morpho: StorageAddress,
    market_collateral: StorageAddress,
    market_oracle: StorageAddress,
    market_irm: StorageAddress,
    market_lltv: StorageU256,
    market_id: StorageB256,
    // --- agent state ---
    nonce: StorageU64,
    last_rebalance: StorageU64,
    regime: StorageU8,
    target_morpho_bps: StorageU16,
    target_uniswap_bps: StorageU16,
    last_inputs_hash: StorageB256,
    // --- guardrails ---
    max_uniswap_bps: StorageU16,
    min_rebalance_interval: StorageU64,
    max_nav_loss_bps: StorageU16,
    min_move: StorageU256,
}

#[public]
impl AgenticVault {
    #[allow(clippy::too_many_arguments)]
    #[constructor]
    pub fn constructor(
        &mut self,
        owner: Address,
        guardian: Address,
        asset: Address,
        verifier: Address,
        fee_engine: Address,
        morpho: Address,
        market_collateral: Address,
        market_oracle: Address,
        market_irm: Address,
        market_lltv: U256,
    ) -> Result<(), VaultError> {
        let required = [owner, guardian, asset, verifier, fee_engine, morpho];
        if required.iter().any(|a| a.is_zero()) {
            return Err(VaultError::ZeroAddress(ZeroAddress {}));
        }
        self.owner.set(owner);
        self.guardian.set(guardian);
        self.asset.set(asset);
        self.verifier.set(verifier);
        self.fee_engine.set(fee_engine);
        self.morpho.set(morpho);
        self.market_collateral.set(market_collateral);
        self.market_oracle.set(market_oracle);
        self.market_irm.set(market_irm);
        self.market_lltv.set(market_lltv);
        self.market_id.set(keccak256(self.market_params().abi_encode()));
        self.max_uniswap_bps.set(U16::from(7_000u16));
        self.min_rebalance_interval.set(U64::from(30u64));
        self.max_nav_loss_bps.set(U16::from(300u16));
        self.min_move.set(U256::from(1_000_000u64)); // 1 USDG (6 decimals)
        Ok(())
    }

    // ------------------------------------------------------------------ ERC-20 shares

    pub fn name(&self) -> String {
        "Agentic Yield Vault USDG".into()
    }

    pub fn symbol(&self) -> String {
        "ayvUSDG".into()
    }

    /// USDG has 6 decimals; shares carry the 6-decimal virtual offset.
    pub fn decimals(&self) -> u8 {
        6 + math::DECIMALS_OFFSET
    }

    pub fn total_supply(&self) -> U256 {
        self.total_supply.get()
    }

    pub fn balance_of(&self, account: Address) -> U256 {
        self.balances.get(account)
    }

    pub fn allowance(&self, owner: Address, spender: Address) -> U256 {
        self.allowances.getter(owner).get(spender)
    }

    pub fn approve(&mut self, spender: Address, value: U256) -> bool {
        let owner = self.vm().msg_sender();
        self.allowances.setter(owner).insert(spender, value);
        self.vm().log(Approval { owner, spender, value });
        true
    }

    pub fn transfer(&mut self, to: Address, value: U256) -> Result<bool, VaultError> {
        let from = self.vm().msg_sender();
        self.move_shares(from, to, value)?;
        Ok(true)
    }

    pub fn transfer_from(&mut self, from: Address, to: Address, value: U256) -> Result<bool, VaultError> {
        let spender = self.vm().msg_sender();
        self.spend_allowance(from, spender, value)?;
        self.move_shares(from, to, value)?;
        Ok(true)
    }

    // ------------------------------------------------------------------ ERC-4626 accounting

    pub fn asset(&self) -> Address {
        self.asset.get()
    }

    pub fn total_assets(&self) -> Result<U256, VaultError> {
        Ok(self.holdings()?.total())
    }

    pub fn convert_to_shares(&self, assets: U256) -> Result<U256, VaultError> {
        Ok(math::convert_to_shares(assets, self.total_supply.get(), self.total_assets()?))
    }

    pub fn convert_to_assets(&self, shares: U256) -> Result<U256, VaultError> {
        Ok(math::convert_to_assets(shares, self.total_supply.get(), self.total_assets()?))
    }

    pub fn preview_deposit(&self, assets: U256) -> Result<U256, VaultError> {
        self.convert_to_shares(assets)
    }

    pub fn preview_redeem(&self, shares: U256) -> Result<U256, VaultError> {
        self.convert_to_assets(shares)
    }

    /// (idle, morpho, uniswap) in USDG units — the dashboard's allocation bar.
    pub fn allocation(&self) -> Result<(U256, U256, U256), VaultError> {
        let h = self.holdings()?;
        Ok((h.idle, h.morpho, h.uniswap))
    }

    pub fn deposit(&mut self, assets: U256, receiver: Address) -> Result<U256, VaultError> {
        self.when_not_paused()?;
        if assets.is_zero() {
            return Err(VaultError::ZeroAmount(ZeroAmount {}));
        }
        if receiver.is_zero() {
            return Err(VaultError::ZeroAddress(ZeroAddress {}));
        }
        let shares = math::convert_to_shares(assets, self.total_supply.get(), self.total_assets()?);
        if shares.is_zero() {
            return Err(VaultError::ZeroAmount(ZeroAmount {}));
        }
        let sender = self.vm().msg_sender();
        let this = self.vm().contract_address();
        self.erc20_transfer_from(sender, this, assets)?;
        self.mint(receiver, shares);
        self.vm().log(Deposit { sender, owner: receiver, assets, shares });
        Ok(shares)
    }

    /// Burns `shares` and pays out USDG, pulling liquidity from Morpho and then the LP leg
    /// if idle cash is short. Works while paused so depositors can always exit. The redeemer
    /// bears LP unwind slippage (bounded by `max_nav_loss_bps`), never the other holders.
    pub fn redeem(&mut self, shares: U256, receiver: Address, owner: Address) -> Result<U256, VaultError> {
        if shares.is_zero() {
            return Err(VaultError::ZeroAmount(ZeroAmount {}));
        }
        if receiver.is_zero() {
            return Err(VaultError::ZeroAddress(ZeroAddress {}));
        }
        let caller = self.vm().msg_sender();
        if caller != owner {
            self.spend_allowance(owner, caller, shares)?;
        }
        let assets = math::convert_to_assets(shares, self.total_supply.get(), self.total_assets()?);
        if assets.is_zero() {
            return Err(VaultError::ZeroAmount(ZeroAmount {}));
        }
        self.burn(owner, shares)?;
        let paid = self.ensure_liquidity(assets, true)?;
        self.erc20_transfer(receiver, paid)?;
        self.vm().log(Withdraw { sender: caller, receiver, owner, assets: paid, shares });
        Ok(paid)
    }

    // ------------------------------------------------------------------ agent intents

    pub fn nonce(&self) -> u64 {
        self.nonce.get().to::<u64>()
    }

    pub fn domain_separator(&self) -> B256 {
        eip712::domain_separator(self.vm().chain_id(), self.vm().contract_address())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn intent_digest(
        &self,
        nonce: u64,
        deadline: u64,
        regime: u8,
        morpho_bps: u16,
        uniswap_bps: u16,
        vol_bps: u16,
        inputs_hash: B256,
        model_version: B256,
    ) -> B256 {
        let intent = self.build_intent(nonce, deadline, regime, morpho_bps, uniswap_bps, vol_bps, inputs_hash, model_version);
        eip712::intent_digest(self.vm().chain_id(), &intent)
    }

    /// (regime, targetMorphoBps, targetUniswapBps, lastRebalance, lastInputsHash)
    pub fn agent_state(&self) -> (u8, u16, u16, u64, B256) {
        (
            self.regime.get().to::<u8>(),
            self.target_morpho_bps.get().to::<u16>(),
            self.target_uniswap_bps.get().to::<u16>(),
            self.last_rebalance.get().to::<u64>(),
            self.last_inputs_hash.get(),
        )
    }

    /// Verifies the agent's signed intent and rebalances accordingly. Anyone may relay it.
    #[allow(clippy::too_many_arguments)]
    pub fn execute_intent(
        &mut self,
        nonce: u64,
        deadline: u64,
        regime: u8,
        morpho_bps: u16,
        uniswap_bps: u16,
        vol_bps: u16,
        inputs_hash: B256,
        model_version: B256,
        signature: Bytes,
    ) -> Result<(), VaultError> {
        self.when_not_paused()?;
        let intent = self.build_intent(nonce, deadline, regime, morpho_bps, uniswap_bps, vol_bps, inputs_hash, model_version);
        self.check_intent(&intent)?;
        let digest = eip712::intent_digest(self.vm().chain_id(), &intent);
        self.check_signature(digest, signature)?;

        // Effects before interactions.
        let now = self.vm().block_timestamp();
        self.nonce.set(U64::from(nonce + 1));
        self.last_rebalance.set(U64::from(now));
        self.regime.set(U8::from(regime));
        self.target_morpho_bps.set(U16::from(morpho_bps));
        self.target_uniswap_bps.set(U16::from(uniswap_bps));
        self.last_inputs_hash.set(inputs_hash);

        self.rebalance(morpho_bps, uniswap_bps)?;
        self.call_mut(
            self.fee_engine.get(),
            IFeeEngine::setRegimeCall { regime, volBps: vol_bps }.abi_encode(),
        )?;
        self.vm().log(IntentExecuted {
            nonce,
            regime,
            morphoBps: morpho_bps,
            uniswapBps: uniswap_bps,
            volBps: vol_bps,
            inputsHash: inputs_hash,
            modelVersion: model_version,
            digest,
        });
        Ok(())
    }

    // ------------------------------------------------------------------ admin & safety

    /// (owner, guardian, verifier, feeEngine, adapter, morpho)
    pub fn wiring(&self) -> (Address, Address, Address, Address, Address, Address) {
        (
            self.owner.get(),
            self.guardian.get(),
            self.verifier.get(),
            self.fee_engine.get(),
            self.adapter.get(),
            self.morpho.get(),
        )
    }

    pub fn market_id(&self) -> B256 {
        self.market_id.get()
    }

    /// (maxUniswapBps, minRebalanceInterval, maxNavLossBps, minMove)
    pub fn guardrails(&self) -> (u16, u64, u16, U256) {
        (
            self.max_uniswap_bps.get().to::<u16>(),
            self.min_rebalance_interval.get().to::<u64>(),
            self.max_nav_loss_bps.get().to::<u16>(),
            self.min_move.get(),
        )
    }

    pub fn paused(&self) -> bool {
        self.paused.get()
    }

    /// One-time wiring of the Uniswap v4 adapter (it needs the vault address at deploy).
    pub fn set_adapter(&mut self, adapter: Address) -> Result<(), VaultError> {
        self.only_owner()?;
        if adapter.is_zero() {
            return Err(VaultError::ZeroAddress(ZeroAddress {}));
        }
        if !self.adapter.get().is_zero() {
            return Err(VaultError::AdapterAlreadySet(AdapterAlreadySet {}));
        }
        self.adapter.set(adapter);
        self.vm().log(AdapterSet { adapter });
        Ok(())
    }

    /// Switch verifier (e.g. BLS -> ECDSA fallback, or rotate after a key compromise).
    pub fn set_verifier(&mut self, verifier: Address) -> Result<(), VaultError> {
        self.only_owner()?;
        if verifier.is_zero() {
            return Err(VaultError::ZeroAddress(ZeroAddress {}));
        }
        let previous = self.verifier.get();
        self.verifier.set(verifier);
        self.vm().log(VerifierChanged { previousVerifier: previous, newVerifier: verifier });
        Ok(())
    }

    pub fn set_guardrails(
        &mut self,
        max_uniswap_bps: u16,
        min_rebalance_interval: u64,
        max_nav_loss_bps: u16,
        min_move: U256,
    ) -> Result<(), VaultError> {
        self.only_owner()?;
        if u64::from(max_uniswap_bps) > BPS || u64::from(max_nav_loss_bps) > BPS {
            return Err(VaultError::InvalidAllocation(InvalidAllocation {
                morphoBps: max_nav_loss_bps,
                uniswapBps: max_uniswap_bps,
            }));
        }
        self.max_uniswap_bps.set(U16::from(max_uniswap_bps));
        self.min_rebalance_interval.set(U64::from(min_rebalance_interval));
        self.max_nav_loss_bps.set(U16::from(max_nav_loss_bps));
        self.min_move.set(min_move);
        self.vm().log(GuardrailsUpdated {
            maxUniswapBps: max_uniswap_bps,
            minRebalanceInterval: min_rebalance_interval,
            maxNavLossBps: max_nav_loss_bps,
            minMove: min_move,
        });
        Ok(())
    }

    pub fn set_guardian(&mut self, guardian: Address) -> Result<(), VaultError> {
        self.only_owner()?;
        if guardian.is_zero() {
            return Err(VaultError::ZeroAddress(ZeroAddress {}));
        }
        let previous = self.guardian.get();
        self.guardian.set(guardian);
        self.vm().log(GuardianChanged { previousGuardian: previous, newGuardian: guardian });
        Ok(())
    }

    pub fn set_paused(&mut self, paused: bool) -> Result<(), VaultError> {
        self.only_guardian_or_owner()?;
        self.paused.set(paused);
        self.vm().log(PausedSet { paused });
        Ok(())
    }

    /// Unwinds every position back to idle USDG and pauses the vault.
    pub fn emergency_exit(&mut self) -> Result<(), VaultError> {
        self.only_guardian_or_owner()?;
        self.paused.set(true);
        self.vm().log(PausedSet { paused: true });
        self.rebalance(0, 0)?;
        let idle = self.idle_assets()?;
        self.vm().log(EmergencyExit { idleAfter: idle });
        Ok(())
    }

    pub fn transfer_ownership(&mut self, new_owner: Address) -> Result<(), VaultError> {
        self.only_owner()?;
        if new_owner.is_zero() {
            return Err(VaultError::ZeroAddress(ZeroAddress {}));
        }
        let previous = self.owner.get();
        self.owner.set(new_owner);
        self.vm().log(OwnershipTransferred { previousOwner: previous, newOwner: new_owner });
        Ok(())
    }
}

mod internal;

#[cfg(test)]
mod eip712_vectors;
#[cfg(test)]
mod tests;

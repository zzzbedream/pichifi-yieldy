//! Vault tests. The pure core (share math, Morpho conversion, allocation planning,
//! EIP-712) is tested exhaustively here. Contract-level tests cover every check that runs
//! before the first external call; multi-call flows (deposit, rebalance, redeem) are
//! exercised end-to-end on a live chain by `scripts/e2e-demo.ts`, because the Stylus
//! TestVM returns the last registered mock for every call.

use super::eip712_vectors as fx;
use super::math::*;
use super::*;
use alloy_primitives::{address, hex};
use stylus_sdk::testing::*;

const OWNER: Address = address!("0x00000000000000000000000000000000000000a1");
const GUARDIAN: Address = address!("0x00000000000000000000000000000000000000a2");
const USDG: Address = address!("0x00000000000000000000000000000000000000b1");
const VERIFIER: Address = address!("0x00000000000000000000000000000000000000b2");
const FEE_ENGINE: Address = address!("0x00000000000000000000000000000000000000b3");
const MORPHO: Address = address!("0x00000000000000000000000000000000000000b4");
const ADAPTER: Address = address!("0x00000000000000000000000000000000000000b5");
const ALICE: Address = address!("0x00000000000000000000000000000000000000c1");
const BOB: Address = address!("0x00000000000000000000000000000000000000c2");
const VAULT_ADDR: Address = address!("0x00000000000000000000000000000000000000aa");
const NOW: u64 = 1_790_000_000;

fn usdg(units: u64) -> U256 {
    U256::from(units) * U256::from(1_000_000u64)
}

fn b256(h: &str) -> B256 {
    B256::from_slice(&hex::decode(h.trim_start_matches("0x")).unwrap())
}

// ------------------------------------------------------------------ share math

#[test]
fn first_deposit_mints_with_virtual_offset() {
    let shares = convert_to_shares(usdg(100), U256::ZERO, U256::ZERO);
    assert_eq!(shares, usdg(100) * U256::from(1_000_000u64));
    assert_eq!(convert_to_assets(shares, shares, usdg(100)), usdg(100) - U256::from(0u64));
}

#[test]
fn share_price_tracks_yield() {
    let supply = convert_to_shares(usdg(100), U256::ZERO, U256::ZERO);
    // Vault earned 10% — the same shares now redeem for ~110 USDG.
    let assets = convert_to_assets(supply, supply, usdg(110));
    assert!(assets <= usdg(110) && assets >= usdg(110) - U256::from(1u64));
    // A later depositor gets fewer shares per USDG (100 USDG now buys < original 100's shares).
    let later = convert_to_shares(usdg(100), supply, usdg(110));
    assert!(later < supply);
}

#[test]
fn inflation_attack_is_unprofitable() {
    // Attacker deposits 1 wei, donates 10k USDG directly, victim deposits 10k USDG.
    let attacker_shares = convert_to_shares(U256::from(1u64), U256::ZERO, U256::ZERO);
    let total_assets = U256::from(1u64) + usdg(10_000);
    let victim_shares = convert_to_shares(usdg(10_000), attacker_shares, total_assets);
    assert!(!victim_shares.is_zero());
    let supply = attacker_shares + victim_shares;
    let victim_assets = convert_to_assets(victim_shares, supply, total_assets + usdg(10_000));
    // Victim keeps >= 99.9% of the deposit.
    assert!(victim_assets * U256::from(1000u64) >= usdg(10_000) * U256::from(999u64));
}

#[test]
fn mul_div_handles_512_bit_intermediates() {
    let big = U256::MAX / U256::from(2u64);
    assert_eq!(mul_div_down(big, U256::from(4u64), U256::from(4u64)), big);
    assert_eq!(mul_div_down(U256::from(7u64), U256::from(3u64), U256::ZERO), U256::ZERO);
}

#[test]
fn morpho_shares_convert_like_shares_math_lib() {
    // 1e6 virtual shares per asset at inception.
    let shares = U256::from(5_000_000_000_000u64);
    assert_eq!(morpho_shares_to_assets(shares, U256::ZERO, U256::ZERO), U256::from(5_000_000u64));
    // After interest: 1_100 assets backing 1_000e6 shares -> 549.95, rounded down.
    let assets = morpho_shares_to_assets(U256::from(500_000_000u64), U256::from(1_100u64), U256::from(1_000_000_000u64));
    assert_eq!(assets, U256::from(549u64));
}

// ------------------------------------------------------------------ allocation planning

#[test]
fn risk_on_from_all_idle_splits_morpho_and_lp() {
    let h = Holdings { idle: usdg(100_000), morpho: U256::ZERO, uniswap: U256::ZERO };
    assert_eq!(plan_unwind_bps(h, 5_000, usdg(1)), 0);
    let moves = plan_moves(h, 5_000, 5_000, usdg(1));
    assert_eq!(moves.uniswap_deploy, usdg(50_000));
    assert_eq!(moves.morpho_supply, usdg(50_000));
    assert_eq!(moves.morpho_withdraw, U256::ZERO);
}

#[test]
fn risk_off_unwinds_lp_fully_and_moves_all_to_morpho() {
    let h = Holdings { idle: U256::ZERO, morpho: usdg(50_000), uniswap: usdg(50_000) };
    assert_eq!(plan_unwind_bps(h, 0, usdg(1)), 10_000);
    let after_unwind = Holdings { idle: usdg(49_900), morpho: usdg(50_000), uniswap: U256::ZERO };
    let moves = plan_moves(after_unwind, 10_000, 0, usdg(1));
    assert_eq!(moves.morpho_supply, usdg(49_900));
    assert_eq!(moves.uniswap_deploy, U256::ZERO);
    assert!(!moves.morpho_withdraw_all);
}

#[test]
fn partial_unwind_rounds_up_to_land_at_target() {
    let h = Holdings { idle: U256::ZERO, morpho: usdg(40_000), uniswap: usdg(60_000) };
    // Target LP 30% of 100k = 30k -> unwind 30k of 60k = 50%.
    assert_eq!(plan_unwind_bps(h, 3_000, usdg(1)), 5_000);
}

#[test]
fn dust_moves_are_skipped() {
    let h = Holdings { idle: U256::from(500_000u64), morpho: usdg(50_000), uniswap: usdg(50_000) };
    let moves = plan_moves(h, 5_000, 5_000, usdg(1));
    assert_eq!(moves, Moves::default());
    assert_eq!(plan_unwind_bps(h, 5_000, usdg(1)), 0);
}

#[test]
fn exit_everything_withdraws_morpho_by_shares() {
    let h = Holdings { idle: usdg(10), morpho: usdg(90), uniswap: U256::ZERO };
    let moves = plan_moves(h, 0, 0, usdg(1));
    assert!(moves.morpho_withdraw_all);
    assert_eq!(moves.morpho_withdraw, usdg(90));
}

#[test]
fn lp_deploy_is_capped_by_available_cash_and_prioritised() {
    let h = Holdings { idle: usdg(10_000), morpho: usdg(90_000), uniswap: U256::ZERO };
    // Target 20% LP (20k) and 80% Morpho (80k): withdraw 10k from Morpho, deploy 20k to LP.
    let moves = plan_moves(h, 8_000, 2_000, usdg(1));
    assert_eq!(moves.morpho_withdraw, usdg(10_000));
    assert_eq!(moves.uniswap_deploy, usdg(20_000));
    assert_eq!(moves.morpho_supply, U256::ZERO);
}

#[test]
fn nav_tolerance_bounds_loss() {
    assert!(nav_within_tolerance(usdg(100), usdg(100), 300));
    assert!(nav_within_tolerance(usdg(100), usdg(97), 300));
    assert!(!nav_within_tolerance(usdg(100), usdg(96), 300));
    assert!(nav_within_tolerance(usdg(100), usdg(120), 0));
}

#[test]
fn shortfall_unwind_adds_buffer_and_caps() {
    assert_eq!(unwind_bps_for_shortfall(usdg(10), usdg(100)), 1_010);
    assert_eq!(unwind_bps_for_shortfall(usdg(200), usdg(100)), 10_000);
    assert_eq!(unwind_bps_for_shortfall(usdg(1), U256::ZERO), 10_000);
}

#[test]
fn allocation_guardrails() {
    assert!(validate_allocation(REGIME_RISK_ON, 5_000, 5_000, 7_000).is_ok());
    assert!(validate_allocation(REGIME_RISK_OFF, 10_000, 0, 7_000).is_ok());
    assert!(validate_allocation(REGIME_RISK_ON, 6_000, 5_000, 7_000).is_err()); // > 100%
    assert!(validate_allocation(REGIME_RISK_ON, 2_000, 8_000, 7_000).is_err()); // LP cap
    assert!(validate_allocation(REGIME_RISK_OFF, 9_000, 1_000, 7_000).is_err()); // LP in risk-off
    assert!(validate_allocation(3, 0, 0, 7_000).is_err());
}

// ------------------------------------------------------------------ EIP-712 parity

fn fixture_intent() -> RebalanceIntent {
    RebalanceIntent {
        vault: fx::VAULT.parse().unwrap(),
        nonce: fx::NONCE,
        deadline: fx::DEADLINE,
        regime: fx::REGIME,
        morpho_bps: fx::MORPHO_BPS,
        uniswap_bps: fx::UNISWAP_BPS,
        vol_bps: fx::VOL_BPS,
        inputs_hash: b256(fx::INPUTS_HASH),
        model_version: b256(fx::MODEL_VERSION),
    }
}

#[test]
fn eip712_digest_matches_viem() {
    assert_eq!(eip712::intent_digest(fx::CHAIN_ID, &fixture_intent()), b256(fx::DIGEST));
}

#[test]
fn eip712_digest_binds_chain_and_fields() {
    let base = eip712::intent_digest(fx::CHAIN_ID, &fixture_intent());
    assert_ne!(eip712::intent_digest(4663, &fixture_intent()), base);
    let tweaked = RebalanceIntent { uniswap_bps: 3_001, ..fixture_intent() };
    assert_ne!(eip712::intent_digest(fx::CHAIN_ID, &tweaked), base);
}

// ------------------------------------------------------------------ contract (pre-call paths)

fn deploy(vm: &TestVM) -> AgenticVault {
    vm.set_contract_address(VAULT_ADDR);
    vm.set_chain_id(fx::CHAIN_ID);
    vm.set_block_timestamp(NOW);
    let mut vault = AgenticVault::from(vm);
    vault
        .constructor(OWNER, GUARDIAN, USDG, VERIFIER, FEE_ENGINE, MORPHO, ALICE, BOB, ALICE, U256::from(860_000_000_000_000_000u64))
        .unwrap();
    vault
}

fn intent_call(vault: &mut AgenticVault, nonce: u64, deadline: u64, regime: u8, morpho: u16, lp: u16) -> Result<(), VaultError> {
    vault.execute_intent(nonce, deadline, regime, morpho, lp, 0, B256::ZERO, B256::ZERO, Bytes::new())
}

#[test]
fn constructor_rejects_zero_wiring() {
    let vm = TestVM::default();
    let mut vault = AgenticVault::from(&vm);
    let r = vault.constructor(OWNER, GUARDIAN, Address::ZERO, VERIFIER, FEE_ENGINE, MORPHO, ALICE, BOB, ALICE, U256::ZERO);
    assert!(matches!(r, Err(VaultError::ZeroAddress(_))));
}

#[test]
fn exposes_metadata_and_defaults() {
    let vm = TestVM::default();
    let vault = deploy(&vm);
    assert_eq!(vault.symbol(), "ayvUSDG");
    assert_eq!(vault.decimals(), 12);
    assert_eq!(vault.asset(), USDG);
    assert_eq!(vault.nonce(), 0);
    assert_eq!(vault.guardrails(), (7_000, 30, 300, usdg(1)));
    assert_eq!(vault.wiring(), (OWNER, GUARDIAN, VERIFIER, FEE_ENGINE, Address::ZERO, MORPHO));
    assert!(!vault.market_id().is_zero());
}

#[test]
fn contract_digest_matches_pure_digest() {
    let vm = TestVM::default();
    let vault = deploy(&vm);
    let i = fixture_intent();
    let expected = eip712::intent_digest(fx::CHAIN_ID, &RebalanceIntent { vault: VAULT_ADDR, ..i });
    let got = vault.intent_digest(i.nonce, i.deadline, i.regime, i.morpho_bps, i.uniswap_bps, i.vol_bps, i.inputs_hash, i.model_version);
    assert_eq!(got, expected);
    assert_eq!(vault.domain_separator(), eip712::domain_separator(fx::CHAIN_ID, VAULT_ADDR));
}

#[test]
fn intent_rejects_wrong_nonce_expired_and_bad_allocation() {
    let vm = TestVM::default();
    let mut vault = deploy(&vm);
    assert!(matches!(intent_call(&mut vault, 1, NOW + 60, 0, 5_000, 0), Err(VaultError::InvalidNonce(_))));
    assert!(matches!(intent_call(&mut vault, 0, NOW - 1, 0, 5_000, 0), Err(VaultError::IntentExpired(_))));
    assert!(matches!(intent_call(&mut vault, 0, NOW + 60, 2, 5_000, 5_000), Err(VaultError::InvalidAllocation(_))));
    assert!(matches!(intent_call(&mut vault, 0, NOW + 60, 0, 2_000, 8_000), Err(VaultError::InvalidAllocation(_))));
}

#[test]
fn intent_requires_adapter_for_lp_allocation() {
    let vm = TestVM::default();
    let mut vault = deploy(&vm);
    assert!(matches!(intent_call(&mut vault, 0, NOW + 60, 0, 5_000, 5_000), Err(VaultError::AdapterNotSet(_))));
}

#[test]
fn intent_rejected_when_verifier_says_no() {
    let vm = TestVM::default();
    let mut vault = deploy(&vm);
    let digest = vault.intent_digest(0, NOW + 60, 2, 10_000, 0, 0, B256::ZERO, B256::ZERO);
    let call = IIntentVerifier::verifyCall { digest, signature: Bytes::new() }.abi_encode();
    vm.mock_static_call(VERIFIER, call, Ok(false.abi_encode()));
    assert!(matches!(intent_call(&mut vault, 0, NOW + 60, 2, 10_000, 0), Err(VaultError::InvalidSignature(_))));
    assert_eq!(vault.nonce(), 0);
}

#[test]
fn paused_vault_rejects_intents_and_deposits() {
    let vm = TestVM::default();
    let mut vault = deploy(&vm);
    vm.set_sender(GUARDIAN);
    vault.set_paused(true).unwrap();
    assert!(vault.paused());
    assert!(matches!(intent_call(&mut vault, 0, NOW + 60, 2, 10_000, 0), Err(VaultError::Paused(_))));
    assert!(matches!(vault.deposit(usdg(1), ALICE), Err(VaultError::Paused(_))));
}

#[test]
fn deposit_and_redeem_validate_inputs() {
    let vm = TestVM::default();
    let mut vault = deploy(&vm);
    assert!(matches!(vault.deposit(U256::ZERO, ALICE), Err(VaultError::ZeroAmount(_))));
    assert!(matches!(vault.deposit(usdg(1), Address::ZERO), Err(VaultError::ZeroAddress(_))));
    assert!(matches!(vault.redeem(U256::ZERO, ALICE, ALICE), Err(VaultError::ZeroAmount(_))));
    vm.set_sender(BOB);
    assert!(matches!(vault.redeem(U256::from(1u64), BOB, ALICE), Err(VaultError::InsufficientAllowance(_))));
}

#[test]
fn admin_functions_are_access_controlled() {
    let vm = TestVM::default();
    let mut vault = deploy(&vm);
    vm.set_sender(ALICE);
    assert!(vault.set_adapter(ADAPTER).is_err());
    assert!(vault.set_verifier(ALICE).is_err());
    assert!(vault.set_guardrails(1, 1, 1, U256::ZERO).is_err());
    assert!(vault.set_guardian(ALICE).is_err());
    assert!(vault.set_paused(true).is_err());
    assert!(vault.emergency_exit().is_err());
    assert!(vault.transfer_ownership(ALICE).is_err());

    vm.set_sender(OWNER);
    vault.set_adapter(ADAPTER).unwrap();
    assert!(matches!(vault.set_adapter(BOB), Err(VaultError::AdapterAlreadySet(_))));
    vault.set_verifier(BOB).unwrap();
    assert!(vault.set_guardrails(10_001, 0, 0, U256::ZERO).is_err());
    vault.set_guardrails(5_000, 60, 100, usdg(5)).unwrap();
    assert_eq!(vault.guardrails(), (5_000, 60, 100, usdg(5)));
    vault.set_guardian(BOB).unwrap();
    vault.transfer_ownership(ALICE).unwrap();
    assert_eq!(vault.wiring().0, ALICE);
}

#[test]
fn share_token_transfers_and_allowances() {
    let vm = TestVM::default();
    let mut vault = deploy(&vm);
    vault.mint(ALICE, U256::from(1_000u64));
    assert_eq!(vault.total_supply(), U256::from(1_000u64));

    vm.set_sender(ALICE);
    assert!(vault.transfer(BOB, U256::from(400u64)).unwrap());
    assert_eq!(vault.balance_of(BOB), U256::from(400u64));
    assert!(matches!(vault.transfer(BOB, U256::from(10_000u64)), Err(VaultError::InsufficientBalance(_))));
    assert!(matches!(vault.transfer(Address::ZERO, U256::from(1u64)), Err(VaultError::ZeroAddress(_))));

    assert!(vault.approve(BOB, U256::from(100u64)));
    vm.set_sender(BOB);
    vault.transfer_from(ALICE, BOB, U256::from(60u64)).unwrap();
    assert_eq!(vault.allowance(ALICE, BOB), U256::from(40u64));
    assert!(vault.transfer_from(ALICE, BOB, U256::from(41u64)).is_err());

    vault.burn(BOB, U256::from(460u64)).unwrap();
    assert_eq!(vault.total_supply(), U256::from(540u64));
    assert!(vault.burn(BOB, U256::from(1u64)).is_err());
}

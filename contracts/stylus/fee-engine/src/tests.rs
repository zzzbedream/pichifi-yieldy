use super::*;
use alloy_primitives::address;
use stylus_sdk::testing::*;

const OWNER: Address = address!("0x00000000000000000000000000000000000000a1");
const VAULT: Address = address!("0x00000000000000000000000000000000000000b2");
const STRANGER: Address = address!("0x00000000000000000000000000000000000000c3");

const BASE: u32 = 3_000; // 0.30%
const MAX: u32 = 50_000; // 5.00%
const SLOPE: u32 = 2; // +2 pips per bps of volatility

fn deploy(vm: &TestVM) -> FeeEngine {
    let mut engine = FeeEngine::from(vm);
    engine.constructor(OWNER, BASE, MAX, SLOPE).unwrap();
    vm.set_sender(OWNER);
    engine.set_updater(VAULT).unwrap();
    engine
}

#[test]
fn compute_fee_follows_regime_schedule() {
    assert_eq!(compute_fee(REGIME_RISK_ON, 9_000, BASE, MAX, SLOPE), BASE);
    assert_eq!(compute_fee(REGIME_VOLATILE, 4_000, BASE, MAX, SLOPE), BASE + 8_000);
    assert_eq!(compute_fee(REGIME_RISK_OFF, 0, BASE, MAX, SLOPE), MAX);
}

#[test]
fn compute_fee_caps_volatile_surcharge_at_max() {
    assert_eq!(compute_fee(REGIME_VOLATILE, u16::MAX, BASE, MAX, u32::MAX), MAX);
}

#[test]
fn starts_risk_on_with_base_fee() {
    let vm = TestVM::default();
    let engine = deploy(&vm);
    assert_eq!(engine.regime(), REGIME_RISK_ON);
    assert_eq!(engine.current_fee_pips(), BASE);
    assert_eq!(engine.owner(), OWNER);
    assert_eq!(engine.updater(), VAULT);
}

#[test]
fn updater_moves_regime_and_fee() {
    let vm = TestVM::default();
    let mut engine = deploy(&vm);
    vm.set_sender(VAULT);

    engine.set_regime(REGIME_VOLATILE, 4_000).unwrap();
    assert_eq!(engine.current_fee_pips(), BASE + 8_000);
    assert_eq!(engine.vol_bps(), 4_000);

    engine.set_regime(REGIME_RISK_OFF, 0).unwrap();
    assert_eq!(engine.current_fee_pips(), MAX);
    assert!(!vm.get_emitted_logs().is_empty());
}

#[test]
fn rejects_regime_update_from_non_updater() {
    let vm = TestVM::default();
    let mut engine = deploy(&vm);
    vm.set_sender(STRANGER);
    assert!(matches!(
        engine.set_regime(REGIME_RISK_OFF, 0),
        Err(FeeEngineError::Unauthorized(_))
    ));
}

#[test]
fn rejects_unknown_regime() {
    let vm = TestVM::default();
    let mut engine = deploy(&vm);
    vm.set_sender(VAULT);
    assert!(matches!(
        engine.set_regime(3, 0),
        Err(FeeEngineError::InvalidRegime(_))
    ));
}

#[test]
fn constructor_rejects_invalid_params() {
    let vm = TestVM::default();
    let mut engine = FeeEngine::from(&vm);
    assert!(matches!(
        engine.constructor(OWNER, MAX + 1, MAX, SLOPE),
        Err(FeeEngineError::InvalidParams(_))
    ));
    assert!(matches!(
        engine.constructor(OWNER, BASE, MAX_LP_FEE + 1, SLOPE),
        Err(FeeEngineError::InvalidParams(_))
    ));
    assert!(matches!(
        engine.constructor(Address::ZERO, BASE, MAX, SLOPE),
        Err(FeeEngineError::ZeroAddress(_))
    ));
}

#[test]
fn only_owner_can_change_params_and_updater() {
    let vm = TestVM::default();
    let mut engine = deploy(&vm);

    vm.set_sender(STRANGER);
    assert!(engine.set_params(1, 2, 3).is_err());
    assert!(engine.set_updater(STRANGER).is_err());
    assert!(engine.transfer_ownership(STRANGER).is_err());

    vm.set_sender(OWNER);
    engine.set_params(1_000, 20_000, 1).unwrap();
    assert_eq!(engine.params(), (1_000, 20_000, 1));
    engine.transfer_ownership(STRANGER).unwrap();
    assert_eq!(engine.owner(), STRANGER);
}

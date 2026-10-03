use super::*;
use stylus_sdk::testing::*;

const OWNER: Address = address!("0x00000000000000000000000000000000000000a1");
const SIGNER: Address = address!("0x00000000000000000000000000000000000000b2");
const OTHER: Address = address!("0x00000000000000000000000000000000000000c3");
const DIGEST: B256 = b256!("0x1111111111111111111111111111111111111111111111111111111111111111");

fn signature(s_byte: u8, v: u8) -> Vec<u8> {
    let mut sig = vec![0x22u8; 32]; // r
    sig.extend_from_slice(&[s_byte; 32]); // s
    sig.push(v);
    sig
}

fn padded(addr: Address) -> Vec<u8> {
    let mut out = vec![0u8; 12];
    out.extend_from_slice(addr.as_slice());
    out
}

fn deploy(vm: &TestVM) -> EcdsaVerifier {
    let mut verifier = EcdsaVerifier::from(vm);
    verifier.constructor(OWNER, SIGNER).unwrap();
    verifier
}

#[test]
fn accepts_signature_recovering_to_signer() {
    let vm = TestVM::default();
    let verifier = deploy(&vm);
    let sig = signature(0x33, 27);
    let input = ecrecover_input(DIGEST, &sig).unwrap();
    vm.mock_static_call(ECRECOVER, input.to_vec(), Ok(padded(SIGNER)));
    assert!(verifier.verify(DIGEST, sig.into()));
}

#[test]
fn normalizes_v_0_and_1() {
    let a = ecrecover_input(DIGEST, &signature(0x33, 0)).unwrap();
    let b = ecrecover_input(DIGEST, &signature(0x33, 27)).unwrap();
    assert_eq!(a, b);
    assert_eq!(ecrecover_input(DIGEST, &signature(0x33, 1)).unwrap()[63], 28);
}

#[test]
fn rejects_other_signer() {
    let vm = TestVM::default();
    let verifier = deploy(&vm);
    let sig = signature(0x33, 28);
    let input = ecrecover_input(DIGEST, &sig).unwrap();
    vm.mock_static_call(ECRECOVER, input.to_vec(), Ok(padded(OTHER)));
    assert!(!verifier.verify(DIGEST, sig.into()));
}

#[test]
fn rejects_high_s_bad_v_and_bad_length() {
    assert!(ecrecover_input(DIGEST, &signature(0xff, 27)).is_none());
    assert!(ecrecover_input(DIGEST, &signature(0x33, 29)).is_none());
    assert!(ecrecover_input(DIGEST, &[0u8; 64]).is_none());
}

#[test]
fn rejects_empty_precompile_output() {
    let vm = TestVM::default();
    let verifier = deploy(&vm);
    let sig = signature(0x33, 27);
    let input = ecrecover_input(DIGEST, &sig).unwrap();
    vm.mock_static_call(ECRECOVER, input.to_vec(), Ok(vec![]));
    assert!(!verifier.verify(DIGEST, sig.into()));
}

#[test]
fn only_owner_rotates_signer() {
    let vm = TestVM::default();
    let mut verifier = deploy(&vm);
    vm.set_sender(OTHER);
    assert!(verifier.set_signer(OTHER).is_err());
    vm.set_sender(OWNER);
    verifier.set_signer(OTHER).unwrap();
    assert_eq!(verifier.signer(), OTHER);
    assert!(verifier.set_signer(Address::ZERO).is_err());
}

#[test]
fn constructor_rejects_zero_addresses() {
    let vm = TestVM::default();
    let mut verifier = EcdsaVerifier::from(&vm);
    assert!(verifier.constructor(Address::ZERO, SIGNER).is_err());
    assert!(verifier.constructor(OWNER, Address::ZERO).is_err());
}

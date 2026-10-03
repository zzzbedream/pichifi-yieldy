//! Vectors come from `agent/scripts/bls-vectors.ts`, which signs with noble/curves (the
//! library behind the Amadeus SDK) and proves the same pipeline against the live
//! EIP-2537 precompiles on Robinhood Chain testnet. Here the precompiles are replaced by
//! an in-memory table holding those exact on-chain results (SHA-256 runs natively).

use super::test_vectors as v;
use super::*;
use alloc::vec;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use stylus_sdk::testing::*;

const OWNER: Address = address!("0x00000000000000000000000000000000000000a1");
const STRANGER: Address = address!("0x00000000000000000000000000000000000000c3");

fn bytes(h: &str) -> Vec<u8> {
    hex::decode(h.trim_start_matches("0x")).unwrap()
}

fn native_sha(data: &[u8]) -> Option<[u8; 32]> {
    Some(Sha256::digest(data).into())
}

fn deploy(vm: &TestVM) -> AmadeusBlsVerifier {
    let mut verifier = AmadeusBlsVerifier::from(vm);
    verifier
        .constructor(
            OWNER,
            bytes(v::PUBLIC_KEY_UNCOMPRESSED).into(),
            bytes(v::PUBLIC_KEY_COMPRESSED).into(),
            v::DST.as_bytes().to_vec().into(),
        )
        .unwrap();
    verifier
}

/// Precompile table built from the real on-chain outputs; anything else "reverts".
struct Precompiles {
    table: HashMap<(Address, Vec<u8>), Vec<u8>>,
    calls: usize,
}

impl Precompiles {
    fn onchain_vectors() -> Self {
        let mut table = HashMap::new();
        table.insert((BLS12_MAP_FP2_TO_G2, bytes(v::U0)), bytes(v::Q0));
        table.insert((BLS12_MAP_FP2_TO_G2, bytes(v::U1)), bytes(v::Q1));
        let mut sum = bytes(v::Q0);
        sum.extend(bytes(v::Q1));
        table.insert((BLS12_G2ADD, sum), bytes(v::HASH_TO_G2));
        let input = pairing_input(
            &bytes(v::PUBLIC_KEY_UNCOMPRESSED),
            &bytes(v::SIGNATURE_UNCOMPRESSED),
            &bytes(v::HASH_TO_G2),
        );
        let mut success = vec![0u8; 32];
        success[31] = 1;
        table.insert((BLS12_PAIRING_CHECK, input), success);
        Self { table, calls: 0 }
    }

    fn call(&mut self, to: Address, input: &[u8]) -> Option<Vec<u8>> {
        self.calls += 1;
        if to == SHA256 {
            return native_sha(input).map(|h| h.to_vec());
        }
        self.table.get(&(to, input.to_vec())).cloned()
    }
}

fn verify_with(precompiles: &mut Precompiles, digest: &[u8], signature: &[u8]) -> bool {
    verify_signature(
        |to, input| precompiles.call(to, input),
        &bytes(v::PUBLIC_KEY_UNCOMPRESSED),
        v::DST.as_bytes(),
        digest,
        signature,
    )
}

#[test]
fn expand_message_xmd_matches_rfc9380_vector() {
    let uniform = expand_message_xmd(native_sha, &bytes(v::DIGEST), v::DST.as_bytes()).unwrap();
    assert_eq!(uniform.to_vec(), bytes(v::UNIFORM_BYTES));
}

#[test]
fn hash_to_field_matches_noble() {
    let uniform: [u8; UNIFORM_LEN] = bytes(v::UNIFORM_BYTES).try_into().unwrap();
    let (u0, u1) = hash_to_field_fp2(&uniform);
    assert_eq!(u0.to_vec(), bytes(v::U0));
    assert_eq!(u1.to_vec(), bytes(v::U1));
}

#[test]
fn neg_g1_constant_matches_noble() {
    assert_eq!(NEG_G1.to_vec(), bytes(v::NEG_G1));
}

#[test]
fn rejects_invalid_dst_lengths() {
    assert!(expand_message_xmd(native_sha, b"m", b"").is_none());
    assert!(expand_message_xmd(native_sha, b"m", &[b'x'; 256]).is_none());
}

#[test]
fn verifies_amadeus_signature() {
    let mut precompiles = Precompiles::onchain_vectors();
    assert!(verify_with(&mut precompiles, &bytes(v::DIGEST), &bytes(v::SIGNATURE_UNCOMPRESSED)));
    // 9 SHA-256 + 2 MAP_FP2_TO_G2 + 1 G2ADD + 1 PAIRING
    assert_eq!(precompiles.calls, 13);
}

#[test]
fn rejects_tampered_signature() {
    let mut precompiles = Precompiles::onchain_vectors();
    let mut signature = bytes(v::SIGNATURE_UNCOMPRESSED);
    signature[200] ^= 0x01;
    assert!(!verify_with(&mut precompiles, &bytes(v::DIGEST), &signature));
}

#[test]
fn rejects_other_digest() {
    let mut precompiles = Precompiles::onchain_vectors();
    assert!(!verify_with(&mut precompiles, &[0x42; 32], &bytes(v::SIGNATURE_UNCOMPRESSED)));
}

#[test]
fn rejects_wrong_lengths_without_calling_precompiles() {
    let mut precompiles = Precompiles::onchain_vectors();
    assert!(!verify_with(&mut precompiles, &bytes(v::DIGEST), &bytes(v::SIGNATURE_COMPRESSED)));
    assert!(!verify_with(&mut precompiles, &bytes(v::DIGEST), &[]));
    assert_eq!(precompiles.calls, 0);
}

#[test]
fn rejects_failed_pairing_output() {
    let mut precompiles = Precompiles::onchain_vectors();
    precompiles.table.retain(|(to, _), _| *to != BLS12_PAIRING_CHECK);
    assert!(!verify_with(&mut precompiles, &bytes(v::DIGEST), &bytes(v::SIGNATURE_UNCOMPRESSED)));
}

#[test]
fn contract_verify_rejects_bad_length_signature() {
    let vm = TestVM::default();
    let verifier = deploy(&vm);
    let digest = B256::from_slice(&bytes(v::DIGEST));
    assert!(!verifier.verify(digest, bytes(v::SIGNATURE_COMPRESSED).into()));
    assert!(!verifier.verify(digest, Bytes::new()));
}

#[test]
fn constructor_validates_inputs() {
    let vm = TestVM::default();
    let pk: Bytes = bytes(v::PUBLIC_KEY_UNCOMPRESSED).into();
    let pkc: Bytes = bytes(v::PUBLIC_KEY_COMPRESSED).into();
    let dst: Bytes = v::DST.as_bytes().to_vec().into();

    let mut verifier = AmadeusBlsVerifier::from(&vm);
    assert!(verifier.constructor(Address::ZERO, pk.clone(), pkc.clone(), dst.clone()).is_err());
    assert!(verifier.constructor(OWNER, vec![0u8; G1_LEN].into(), pkc.clone(), dst.clone()).is_err());
    assert!(verifier.constructor(OWNER, pk.clone(), vec![1u8; 10].into(), dst).is_err());
    assert!(verifier.constructor(OWNER, pk, pkc, Bytes::new()).is_err());
}

#[test]
fn exposes_key_metadata() {
    let vm = TestVM::default();
    let verifier = deploy(&vm);
    assert_eq!(verifier.public_key_compressed().to_vec(), bytes(v::PUBLIC_KEY_COMPRESSED));
    assert_eq!(verifier.public_key().to_vec(), bytes(v::PUBLIC_KEY_UNCOMPRESSED));
    assert_eq!(verifier.dst().to_vec(), v::DST.as_bytes().to_vec());
    assert_eq!(verifier.owner(), OWNER);
    assert!(verifier.scheme().contains("BLS12-381"));
}

#[test]
fn only_owner_rotates_key() {
    let vm = TestVM::default();
    let mut verifier = deploy(&vm);
    let pk: Bytes = bytes(v::PUBLIC_KEY_UNCOMPRESSED).into();
    let pkc: Bytes = bytes(v::PUBLIC_KEY_COMPRESSED).into();

    vm.set_sender(STRANGER);
    assert!(verifier.set_public_key(pk.clone(), pkc.clone()).is_err());
    assert!(verifier.transfer_ownership(STRANGER).is_err());

    vm.set_sender(OWNER);
    verifier.set_public_key(pk, pkc).unwrap();
    verifier.transfer_ownership(STRANGER).unwrap();
    assert_eq!(verifier.owner(), STRANGER);
}

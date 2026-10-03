//! AmadeusBlsVerifier — verifies Amadeus-native BLS12-381 signatures on-chain.
//!
//! Amadeus accounts are BLS12-381 "min_pk" keys: the public key lives in G1 and
//! signatures in G2. The agent signs the vault's 32-byte EIP-712 intent digest with its
//! Amadeus key under a dedicated DST. This contract checks that signature using only
//! EVM precompiles (EIP-2537 + SHA-256), all live on Robinhood Chain (ArbOS 61):
//!
//! 1. `expand_message_xmd` (RFC 9380, SHA-256 precompile `0x02`) -> 256 uniform bytes
//! 2. `hash_to_field`: four 64-byte chunks reduced mod p -> u0, u1 in Fp2
//! 3. `MAP_FP2_TO_G2` (`0x11`) on u0 and u1 -> Q0, Q1   (map + cofactor clearing)
//! 4. `G2ADD` (`0x0d`) -> H(m) = Q0 + Q1
//! 5. `PAIRING_CHECK` (`0x0f`): e(-G1, sig) * e(pk, H(m)) == 1
//!
//! Points are passed uncompressed (EIP-2537 encoding) so no square roots run on-chain.
//! The pairing precompile performs the subgroup checks on `sig` and `pk`.

#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use alloc::{string::String, vec::Vec};
use alloy_primitives::{address, hex, uint, Address, Bytes, B256, U512};
use alloy_sol_types::sol;
use stylus_sdk::{
    call::static_call,
    prelude::*,
    storage::{StorageAddress, StorageBytes},
};

pub const SHA256: Address = address!("0x0000000000000000000000000000000000000002");
pub const BLS12_G2ADD: Address = address!("0x000000000000000000000000000000000000000d");
pub const BLS12_PAIRING_CHECK: Address = address!("0x000000000000000000000000000000000000000f");
pub const BLS12_MAP_FP2_TO_G2: Address = address!("0x0000000000000000000000000000000000000011");

pub const FP_LEN: usize = 64;
pub const G1_LEN: usize = 128;
pub const G2_LEN: usize = 256;
pub const COMPRESSED_G1_LEN: usize = 48;
/// hash_to_field for G2: count = 2, m = 2, L = 64.
pub const UNIFORM_LEN: usize = 256;
const SHA256_BLOCK: usize = 64;
/// Gas caps: an invalid point makes a precompile consume all forwarded gas, so each call is
/// capped (EIP-2537 costs: map 23,800; add 600; 2-pair check 102,900).
pub const SHA256_GAS: u64 = 5_000;
pub const MAP_GAS: u64 = 50_000;
pub const ADD_GAS: u64 = 10_000;
pub const PAIRING_GAS: u64 = 150_000;

/// Gas cap for a call to `precompile`.
pub fn precompile_gas(precompile: Address) -> u64 {
    match precompile {
        SHA256 => SHA256_GAS,
        BLS12_MAP_FP2_TO_G2 => MAP_GAS,
        BLS12_G2ADD => ADD_GAS,
        _ => PAIRING_GAS,
    }
}
const SHA256_OUT: usize = 32;

/// BLS12-381 base field modulus p.
const P: U512 = uint!(0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab_U512);

/// EIP-2537 encoding of -G1 (generator negated), the fixed first pairing operand.
pub const NEG_G1: [u8; G1_LEN] = hex!("0000000000000000000000000000000017f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb00000000000000000000000000000000114d1d6855d545a8aa7d76c8cf2e21f267816aef1db507c96655b9d5caac42364e6f38ba0ecb751bad54dcd6b939c2ca");

sol! {
    event PublicKeyChanged(bytes publicKeyCompressed);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized(address caller);
    error ZeroAddress();
    error InvalidPublicKey();
    error InvalidDst();
}

#[derive(SolidityError)]
pub enum BlsVerifierError {
    Unauthorized(Unauthorized),
    ZeroAddress(ZeroAddress),
    InvalidPublicKey(InvalidPublicKey),
    InvalidDst(InvalidDst),
}

impl core::fmt::Debug for BlsVerifierError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(match self {
            Self::Unauthorized(_) => "Unauthorized",
            Self::ZeroAddress(_) => "ZeroAddress",
            Self::InvalidPublicKey(_) => "InvalidPublicKey",
            Self::InvalidDst(_) => "InvalidDst",
        })
    }
}

/// RFC 9380 §5.3.1 `expand_message_xmd` with SHA-256, fixed to 256 output bytes.
/// `sha` is injected so tests can run it natively; on-chain it is the `0x02` precompile.
pub fn expand_message_xmd<F>(mut sha: F, msg: &[u8], dst: &[u8]) -> Option<[u8; UNIFORM_LEN]>
where
    F: FnMut(&[u8]) -> Option<[u8; SHA256_OUT]>,
{
    if dst.is_empty() || dst.len() > 255 {
        return None;
    }
    let ell = UNIFORM_LEN / SHA256_OUT;
    let mut dst_prime = Vec::with_capacity(dst.len() + 1);
    dst_prime.extend_from_slice(dst);
    dst_prime.push(dst.len() as u8);

    let mut msg_prime = Vec::with_capacity(SHA256_BLOCK + msg.len() + 3 + dst_prime.len());
    msg_prime.extend_from_slice(&[0u8; SHA256_BLOCK]);
    msg_prime.extend_from_slice(msg);
    msg_prime.extend_from_slice(&(UNIFORM_LEN as u16).to_be_bytes());
    msg_prime.push(0);
    msg_prime.extend_from_slice(&dst_prime);
    let b0 = sha(&msg_prime)?;

    let mut out = [0u8; UNIFORM_LEN];
    let mut prev = [0u8; SHA256_OUT];
    for i in 1..=ell {
        let mut input = Vec::with_capacity(SHA256_OUT + 1 + dst_prime.len());
        for (j, b) in b0.iter().enumerate() {
            input.push(if i == 1 { *b } else { b ^ prev[j] });
        }
        input.push(i as u8);
        input.extend_from_slice(&dst_prime);
        prev = sha(&input)?;
        out[(i - 1) * SHA256_OUT..i * SHA256_OUT].copy_from_slice(&prev);
    }
    Some(out)
}

/// OS2IP(64 bytes) mod p, in EIP-2537 Fp encoding (64 bytes, top 16 zero).
pub fn reduce_to_fp(chunk: &[u8]) -> [u8; FP_LEN] {
    let reduced = U512::from_be_slice(chunk) % P;
    reduced.to_be_bytes::<FP_LEN>()
}

/// RFC 9380 hash_to_field for G2: returns (u0, u1) as EIP-2537 Fp2 encodings (c0 || c1).
pub fn hash_to_field_fp2(uniform: &[u8; UNIFORM_LEN]) -> ([u8; 2 * FP_LEN], [u8; 2 * FP_LEN]) {
    let mut u0 = [0u8; 2 * FP_LEN];
    let mut u1 = [0u8; 2 * FP_LEN];
    for (k, chunk) in uniform.chunks_exact(FP_LEN).enumerate() {
        let fp = reduce_to_fp(chunk);
        let target = if k < 2 { &mut u0 } else { &mut u1 };
        let offset = (k % 2) * FP_LEN;
        target[offset..offset + FP_LEN].copy_from_slice(&fp);
    }
    (u0, u1)
}

/// Pairing input: (-G1, sig) || (pk, H(m)).
pub fn pairing_input(public_key: &[u8], signature: &[u8], hashed: &[u8]) -> Vec<u8> {
    let mut input = Vec::with_capacity(2 * (G1_LEN + G2_LEN));
    input.extend_from_slice(&NEG_G1);
    input.extend_from_slice(signature);
    input.extend_from_slice(public_key);
    input.extend_from_slice(hashed);
    input
}

fn is_pairing_success(output: &[u8]) -> bool {
    output.len() == 32 && output[..31].iter().all(|b| *b == 0) && output[31] == 1
}

/// Full BLS verification. `precompile(address, input)` performs a static call and returns
/// its output (`None` on revert); injected so the pipeline is testable off-chain.
pub fn verify_signature<F>(
    mut precompile: F,
    public_key: &[u8],
    dst: &[u8],
    digest: &[u8],
    signature: &[u8],
) -> bool
where
    F: FnMut(Address, &[u8]) -> Option<Vec<u8>>,
{
    if signature.len() != G2_LEN || public_key.len() != G1_LEN {
        return false;
    }
    let uniform = expand_message_xmd(
        |data| precompile(SHA256, data)?.try_into().ok(),
        digest,
        dst,
    );
    let Some(uniform) = uniform else {
        return false;
    };
    let (u0, u1) = hash_to_field_fp2(&uniform);
    let mut call_g2 = |to: Address, input: &[u8]| -> Option<Vec<u8>> {
        let out = precompile(to, input)?;
        (out.len() == G2_LEN).then_some(out)
    };
    let Some(mut sum_input) = call_g2(BLS12_MAP_FP2_TO_G2, &u0) else {
        return false;
    };
    let Some(q1) = call_g2(BLS12_MAP_FP2_TO_G2, &u1) else {
        return false;
    };
    sum_input.extend_from_slice(&q1);
    let Some(hashed) = call_g2(BLS12_G2ADD, &sum_input) else {
        return false;
    };
    let input = pairing_input(public_key, signature, &hashed);
    precompile(BLS12_PAIRING_CHECK, &input).is_some_and(|out| is_pairing_success(&out))
}

#[storage]
#[entrypoint]
pub struct AmadeusBlsVerifier {
    owner: StorageAddress,
    /// Uncompressed EIP-2537 G1 public key (128 bytes).
    public_key: StorageBytes,
    /// Compressed Amadeus public key (48 bytes) — the agent's Amadeus account id.
    public_key_compressed: StorageBytes,
    dst: StorageBytes,
}

#[public]
impl AmadeusBlsVerifier {
    #[constructor]
    pub fn constructor(
        &mut self,
        owner: Address,
        public_key: Bytes,
        public_key_compressed: Bytes,
        dst: Bytes,
    ) -> Result<(), BlsVerifierError> {
        if owner.is_zero() {
            return Err(BlsVerifierError::ZeroAddress(ZeroAddress {}));
        }
        if dst.is_empty() || dst.len() > 255 {
            return Err(BlsVerifierError::InvalidDst(InvalidDst {}));
        }
        self.owner.set(owner);
        self.dst.set_bytes(&dst);
        self.store_public_key(&public_key, &public_key_compressed)
    }

    /// `true` iff `signature` (uncompressed G2, 256 bytes) is a valid BLS signature of
    /// `digest` by the configured Amadeus key. Never reverts on bad input.
    pub fn verify(&self, digest: B256, signature: Bytes) -> bool {
        if signature.len() != G2_LEN {
            return false;
        }
        let host = self.vm();
        verify_signature(
            |to, input| static_call(host, Call::new().gas(precompile_gas(to)), to, input).ok(),
            &self.public_key.get_bytes(),
            &self.dst.get_bytes(),
            digest.as_slice(),
            &signature,
        )
    }

    /// Identifier the dashboard shows next to each verified intent.
    pub fn scheme(&self) -> String {
        "BLS12-381-G2 (Amadeus)".into()
    }

    pub fn public_key(&self) -> Bytes {
        self.public_key.get_bytes().into()
    }

    pub fn public_key_compressed(&self) -> Bytes {
        self.public_key_compressed.get_bytes().into()
    }

    pub fn dst(&self) -> Bytes {
        self.dst.get_bytes().into()
    }

    pub fn owner(&self) -> Address {
        self.owner.get()
    }

    /// Key rotation (e.g. a compromised agent key).
    pub fn set_public_key(
        &mut self,
        public_key: Bytes,
        public_key_compressed: Bytes,
    ) -> Result<(), BlsVerifierError> {
        self.only_owner()?;
        self.store_public_key(&public_key, &public_key_compressed)
    }

    pub fn transfer_ownership(&mut self, new_owner: Address) -> Result<(), BlsVerifierError> {
        self.only_owner()?;
        if new_owner.is_zero() {
            return Err(BlsVerifierError::ZeroAddress(ZeroAddress {}));
        }
        let previous = self.owner.get();
        self.owner.set(new_owner);
        self.vm().log(OwnershipTransferred {
            previousOwner: previous,
            newOwner: new_owner,
        });
        Ok(())
    }
}

impl AmadeusBlsVerifier {
    fn only_owner(&self) -> Result<(), BlsVerifierError> {
        let caller = self.vm().msg_sender();
        if caller != self.owner.get() {
            return Err(BlsVerifierError::Unauthorized(Unauthorized { caller }));
        }
        Ok(())
    }

    fn store_public_key(&mut self, uncompressed: &[u8], compressed: &[u8]) -> Result<(), BlsVerifierError> {
        let is_infinity = uncompressed.iter().all(|b| *b == 0);
        if uncompressed.len() != G1_LEN || compressed.len() != COMPRESSED_G1_LEN || is_infinity {
            return Err(BlsVerifierError::InvalidPublicKey(InvalidPublicKey {}));
        }
        self.public_key.set_bytes(uncompressed);
        self.public_key_compressed.set_bytes(compressed);
        self.vm().log(PublicKeyChanged {
            publicKeyCompressed: compressed.to_vec().into(),
        });
        Ok(())
    }
}

#[cfg(test)]
mod test_vectors;
#[cfg(test)]
mod tests;

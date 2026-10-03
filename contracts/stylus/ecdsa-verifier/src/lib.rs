//! EcdsaVerifier — fallback intent verifier (secp256k1, `ecrecover` precompile).
//!
//! Exposes the same `verify(bytes32 digest, bytes signature) returns (bool)` interface as
//! `AmadeusBlsVerifier`, so the vault can switch schemes without code changes.
//! Rejects malleable signatures (high `s`) and never reverts on a bad signature:
//! it returns `false` and lets the vault decide.

#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use alloc::vec::Vec;
use alloy_primitives::{address, b256, Address, Bytes, B256, U256};
use alloy_sol_types::sol;
use stylus_sdk::{call::static_call, prelude::*, storage::StorageAddress};

pub const ECRECOVER: Address = address!("0x0000000000000000000000000000000000000001");

/// secp256k1n / 2 — upper bound for `s` (EIP-2).
pub const HALF_ORDER: B256 =
    b256!("0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0");

sol! {
    event SignerChanged(address indexed previousSigner, address indexed newSigner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized(address caller);
    error ZeroAddress();
}

#[derive(SolidityError)]
pub enum EcdsaVerifierError {
    Unauthorized(Unauthorized),
    ZeroAddress(ZeroAddress),
}

impl core::fmt::Debug for EcdsaVerifierError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(match self {
            Self::Unauthorized(_) => "Unauthorized",
            Self::ZeroAddress(_) => "ZeroAddress",
        })
    }
}

#[storage]
#[entrypoint]
pub struct EcdsaVerifier {
    owner: StorageAddress,
    signer: StorageAddress,
}

/// Builds the 128-byte `ecrecover` input from a 65-byte `r || s || v` signature.
/// Returns `None` for malformed or malleable signatures.
pub fn ecrecover_input(digest: B256, signature: &[u8]) -> Option<[u8; 128]> {
    if signature.len() != 65 {
        return None;
    }
    let s = U256::from_be_slice(&signature[32..64]);
    if s > U256::from_be_bytes(HALF_ORDER.0) {
        return None;
    }
    let v = match signature[64] {
        0 | 1 => signature[64] + 27,
        27 | 28 => signature[64],
        _ => return None,
    };
    let mut input = [0u8; 128];
    input[..32].copy_from_slice(digest.as_slice());
    input[63] = v;
    input[64..128].copy_from_slice(&signature[..64]);
    Some(input)
}

#[public]
impl EcdsaVerifier {
    #[constructor]
    pub fn constructor(&mut self, owner: Address, signer: Address) -> Result<(), EcdsaVerifierError> {
        if owner.is_zero() || signer.is_zero() {
            return Err(EcdsaVerifierError::ZeroAddress(ZeroAddress {}));
        }
        self.owner.set(owner);
        self.signer.set(signer);
        Ok(())
    }

    /// `true` iff `signature` is a valid, non-malleable secp256k1 signature of `digest`
    /// by the configured signer.
    pub fn verify(&self, digest: B256, signature: Bytes) -> bool {
        let Some(input) = ecrecover_input(digest, &signature) else {
            return false;
        };
        let Ok(output) = static_call(self.vm(), Call::new(), ECRECOVER, &input) else {
            return false;
        };
        if output.len() != 32 {
            return false;
        }
        let recovered = Address::from_slice(&output[12..32]);
        !recovered.is_zero() && recovered == self.signer.get()
    }

    /// Identifier the dashboard shows next to each verified intent.
    pub fn scheme(&self) -> alloc::string::String {
        "ECDSA-secp256k1".into()
    }

    pub fn signer(&self) -> Address {
        self.signer.get()
    }

    pub fn owner(&self) -> Address {
        self.owner.get()
    }

    /// Key rotation (e.g. a compromised agent key).
    pub fn set_signer(&mut self, signer: Address) -> Result<(), EcdsaVerifierError> {
        self.only_owner()?;
        if signer.is_zero() {
            return Err(EcdsaVerifierError::ZeroAddress(ZeroAddress {}));
        }
        let previous = self.signer.get();
        self.signer.set(signer);
        self.vm().log(SignerChanged {
            previousSigner: previous,
            newSigner: signer,
        });
        Ok(())
    }

    pub fn transfer_ownership(&mut self, new_owner: Address) -> Result<(), EcdsaVerifierError> {
        self.only_owner()?;
        if new_owner.is_zero() {
            return Err(EcdsaVerifierError::ZeroAddress(ZeroAddress {}));
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

impl EcdsaVerifier {
    fn only_owner(&self) -> Result<(), EcdsaVerifierError> {
        let caller = self.vm().msg_sender();
        if caller != self.owner.get() {
            return Err(EcdsaVerifierError::Unauthorized(Unauthorized { caller }));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;

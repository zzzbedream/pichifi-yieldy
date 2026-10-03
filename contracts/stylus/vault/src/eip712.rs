//! EIP-712 hashing for `RebalanceIntent`. Must stay byte-identical to the agent's
//! `hashTypedData` (see `agent/src/intent/eip712.ts`); a shared fixture tests parity.

use alloc::vec::Vec;
use alloy_primitives::{keccak256, Address, B256, U256};

pub const DOMAIN_NAME: &str = "AgenticYieldVault";
pub const DOMAIN_VERSION: &str = "1";
pub const DOMAIN_TYPE: &str =
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
pub const INTENT_TYPE: &str = "RebalanceIntent(address vault,uint64 nonce,uint64 deadline,uint8 regime,uint16 morphoBps,uint16 uniswapBps,uint16 volBps,bytes32 inputsHash,bytes32 modelVersion)";

/// The agent's signed rebalancing instruction.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RebalanceIntent {
    pub vault: Address,
    pub nonce: u64,
    pub deadline: u64,
    pub regime: u8,
    pub morpho_bps: u16,
    pub uniswap_bps: u16,
    pub vol_bps: u16,
    pub inputs_hash: B256,
    pub model_version: B256,
}

fn word_u64(v: u64) -> [u8; 32] {
    U256::from(v).to_be_bytes::<32>()
}

fn word_address(a: Address) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a.as_slice());
    w
}

pub fn domain_separator(chain_id: u64, verifying_contract: Address) -> B256 {
    let mut enc = Vec::with_capacity(5 * 32);
    enc.extend_from_slice(keccak256(DOMAIN_TYPE).as_slice());
    enc.extend_from_slice(keccak256(DOMAIN_NAME).as_slice());
    enc.extend_from_slice(keccak256(DOMAIN_VERSION).as_slice());
    enc.extend_from_slice(&word_u64(chain_id));
    enc.extend_from_slice(&word_address(verifying_contract));
    keccak256(enc)
}

pub fn struct_hash(intent: &RebalanceIntent) -> B256 {
    let mut enc = Vec::with_capacity(10 * 32);
    enc.extend_from_slice(keccak256(INTENT_TYPE).as_slice());
    enc.extend_from_slice(&word_address(intent.vault));
    enc.extend_from_slice(&word_u64(intent.nonce));
    enc.extend_from_slice(&word_u64(intent.deadline));
    enc.extend_from_slice(&word_u64(u64::from(intent.regime)));
    enc.extend_from_slice(&word_u64(u64::from(intent.morpho_bps)));
    enc.extend_from_slice(&word_u64(u64::from(intent.uniswap_bps)));
    enc.extend_from_slice(&word_u64(u64::from(intent.vol_bps)));
    enc.extend_from_slice(intent.inputs_hash.as_slice());
    enc.extend_from_slice(intent.model_version.as_slice());
    keccak256(enc)
}

/// keccak256(0x1901 || domainSeparator || structHash)
pub fn intent_digest(chain_id: u64, intent: &RebalanceIntent) -> B256 {
    let mut enc = Vec::with_capacity(2 + 64);
    enc.extend_from_slice(&[0x19, 0x01]);
    enc.extend_from_slice(domain_separator(chain_id, intent.vault).as_slice());
    enc.extend_from_slice(struct_hash(intent).as_slice());
    keccak256(enc)
}

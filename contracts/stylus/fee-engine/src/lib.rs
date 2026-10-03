//! FeeEngine — Rust/Stylus fee logic for the Uniswap v4 DynamicFeeHook.
//!
//! The vault forwards the agent's risk regime and realized-volatility estimate here.
//! The Solidity hook reads `currentFeePips()` in `beforeSwap` and returns it with
//! `OVERRIDE_FEE_FLAG`, so the swap fee charged to takers (arbitrageurs included)
//! tracks the agent's view of adverse-selection risk.
//!
//! Fee schedule (pips, 1_000_000 = 100%):
//! - RISK_ON:  `base`
//! - VOLATILE: `min(base + volBps * slope, max)`
//! - RISK_OFF: `max`

#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use alloc::vec::Vec;
use alloy_primitives::{Address, U16, U32, U8};
use alloy_sol_types::sol;
use stylus_sdk::{
    prelude::*,
    storage::{StorageAddress, StorageU16, StorageU32, StorageU8},
};

/// Uniswap v4 `LPFeeLibrary.MAX_LP_FEE`.
pub const MAX_LP_FEE: u32 = 1_000_000;

pub const REGIME_RISK_ON: u8 = 0;
pub const REGIME_VOLATILE: u8 = 1;
pub const REGIME_RISK_OFF: u8 = 2;

sol! {
    event RegimeUpdated(uint8 regime, uint16 volBps, uint32 feePips);
    event ParamsUpdated(uint32 baseFeePips, uint32 maxFeePips, uint32 slopePipsPerBps);
    event UpdaterChanged(address indexed previousUpdater, address indexed newUpdater);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized(address caller);
    error InvalidRegime(uint8 regime);
    error InvalidParams(uint32 baseFeePips, uint32 maxFeePips);
    error ZeroAddress();
}

#[derive(SolidityError)]
pub enum FeeEngineError {
    Unauthorized(Unauthorized),
    InvalidRegime(InvalidRegime),
    InvalidParams(InvalidParams),
    ZeroAddress(ZeroAddress),
}

impl core::fmt::Debug for FeeEngineError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(match self {
            Self::Unauthorized(_) => "Unauthorized",
            Self::InvalidRegime(_) => "InvalidRegime",
            Self::InvalidParams(_) => "InvalidParams",
            Self::ZeroAddress(_) => "ZeroAddress",
        })
    }
}

#[storage]
#[entrypoint]
pub struct FeeEngine {
    owner: StorageAddress,
    updater: StorageAddress,
    regime: StorageU8,
    vol_bps: StorageU16,
    base_fee_pips: StorageU32,
    max_fee_pips: StorageU32,
    slope_pips_per_bps: StorageU32,
}

/// Pure fee schedule, shared by the contract and its tests.
pub fn compute_fee(regime: u8, vol_bps: u16, base: u32, max: u32, slope: u32) -> u32 {
    match regime {
        REGIME_RISK_ON => base,
        REGIME_VOLATILE => {
            let surcharge = u64::from(vol_bps) * u64::from(slope);
            let fee = u64::from(base).saturating_add(surcharge);
            fee.min(u64::from(max)) as u32
        }
        _ => max,
    }
}

fn validate_params(base: u32, max: u32) -> Result<(), FeeEngineError> {
    if base > max || max > MAX_LP_FEE {
        return Err(FeeEngineError::InvalidParams(InvalidParams {
            baseFeePips: base,
            maxFeePips: max,
        }));
    }
    Ok(())
}

#[public]
impl FeeEngine {
    #[constructor]
    pub fn constructor(
        &mut self,
        owner: Address,
        base_fee_pips: u32,
        max_fee_pips: u32,
        slope_pips_per_bps: u32,
    ) -> Result<(), FeeEngineError> {
        if owner.is_zero() {
            return Err(FeeEngineError::ZeroAddress(ZeroAddress {}));
        }
        validate_params(base_fee_pips, max_fee_pips)?;
        self.owner.set(owner);
        self.base_fee_pips.set(U32::from(base_fee_pips));
        self.max_fee_pips.set(U32::from(max_fee_pips));
        self.slope_pips_per_bps.set(U32::from(slope_pips_per_bps));
        self.regime.set(U8::from(REGIME_RISK_ON));
        Ok(())
    }

    /// Fee (pips) the hook applies to the next swap.
    pub fn current_fee_pips(&self) -> u32 {
        compute_fee(
            self.regime.get().to::<u8>(),
            self.vol_bps.get().to::<u16>(),
            self.base_fee_pips.get().to::<u32>(),
            self.max_fee_pips.get().to::<u32>(),
            self.slope_pips_per_bps.get().to::<u32>(),
        )
    }

    pub fn regime(&self) -> u8 {
        self.regime.get().to::<u8>()
    }

    pub fn vol_bps(&self) -> u16 {
        self.vol_bps.get().to::<u16>()
    }

    pub fn params(&self) -> (u32, u32, u32) {
        (
            self.base_fee_pips.get().to::<u32>(),
            self.max_fee_pips.get().to::<u32>(),
            self.slope_pips_per_bps.get().to::<u32>(),
        )
    }

    pub fn owner(&self) -> Address {
        self.owner.get()
    }

    pub fn updater(&self) -> Address {
        self.updater.get()
    }

    /// Called by the vault when it executes a verified intent.
    pub fn set_regime(&mut self, regime: u8, vol_bps: u16) -> Result<(), FeeEngineError> {
        let caller = self.vm().msg_sender();
        if caller != self.updater.get() {
            return Err(FeeEngineError::Unauthorized(Unauthorized { caller }));
        }
        if regime > REGIME_RISK_OFF {
            return Err(FeeEngineError::InvalidRegime(InvalidRegime { regime }));
        }
        self.regime.set(U8::from(regime));
        self.vol_bps.set(U16::from(vol_bps));
        let fee = self.current_fee_pips();
        self.vm().log(RegimeUpdated {
            regime,
            volBps: vol_bps,
            feePips: fee,
        });
        Ok(())
    }

    pub fn set_updater(&mut self, updater: Address) -> Result<(), FeeEngineError> {
        self.only_owner()?;
        let previous = self.updater.get();
        self.updater.set(updater);
        self.vm().log(UpdaterChanged {
            previousUpdater: previous,
            newUpdater: updater,
        });
        Ok(())
    }

    pub fn set_params(
        &mut self,
        base_fee_pips: u32,
        max_fee_pips: u32,
        slope_pips_per_bps: u32,
    ) -> Result<(), FeeEngineError> {
        self.only_owner()?;
        validate_params(base_fee_pips, max_fee_pips)?;
        self.base_fee_pips.set(U32::from(base_fee_pips));
        self.max_fee_pips.set(U32::from(max_fee_pips));
        self.slope_pips_per_bps.set(U32::from(slope_pips_per_bps));
        self.vm().log(ParamsUpdated {
            baseFeePips: base_fee_pips,
            maxFeePips: max_fee_pips,
            slopePipsPerBps: slope_pips_per_bps,
        });
        Ok(())
    }

    pub fn transfer_ownership(&mut self, new_owner: Address) -> Result<(), FeeEngineError> {
        self.only_owner()?;
        if new_owner.is_zero() {
            return Err(FeeEngineError::ZeroAddress(ZeroAddress {}));
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

impl FeeEngine {
    fn only_owner(&self) -> Result<(), FeeEngineError> {
        let caller = self.vm().msg_sender();
        if caller != self.owner.get() {
            return Err(FeeEngineError::Unauthorized(Unauthorized { caller }));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;

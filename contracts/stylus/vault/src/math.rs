//! Pure vault math: share accounting, Morpho share conversion and allocation planning.
//! No storage or host access here, so everything is unit-testable.

use alloy_primitives::{U256, U512};

pub const BPS: u64 = 10_000;
/// Virtual share offset (OpenZeppelin ERC-4626 style) — mitigates the inflation attack.
pub const DECIMALS_OFFSET: u8 = 6;
/// Morpho Blue `SharesMathLib.VIRTUAL_SHARES`.
pub const MORPHO_VIRTUAL_SHARES: u64 = 1_000_000;
/// Morpho Blue `SharesMathLib.VIRTUAL_ASSETS`.
pub const MORPHO_VIRTUAL_ASSETS: u64 = 1;

fn virtual_shares() -> U256 {
    U256::from(10u64).pow(U256::from(DECIMALS_OFFSET))
}

/// floor(assets * (supply + 10^offset) / (totalAssets + 1))
pub fn convert_to_shares(assets: U256, total_supply: U256, total_assets: U256) -> U256 {
    mul_div_down(assets, total_supply + virtual_shares(), total_assets + U256::from(1))
}

/// floor(shares * (totalAssets + 1) / (supply + 10^offset))
pub fn convert_to_assets(shares: U256, total_supply: U256, total_assets: U256) -> U256 {
    mul_div_down(shares, total_assets + U256::from(1), total_supply + virtual_shares())
}

/// Morpho `toAssetsDown`: shares * (totalAssets + 1) / (totalShares + 1e6).
pub fn morpho_shares_to_assets(shares: U256, total_supply_assets: U256, total_supply_shares: U256) -> U256 {
    mul_div_down(
        shares,
        total_supply_assets + U256::from(MORPHO_VIRTUAL_ASSETS),
        total_supply_shares + U256::from(MORPHO_VIRTUAL_SHARES),
    )
}

/// floor(a * b / denominator) with a 512-bit intermediate; 0 when denominator is 0.
pub fn mul_div_down(a: U256, b: U256, denominator: U256) -> U256 {
    if denominator.is_zero() {
        return U256::ZERO;
    }
    let product: U512 = a.widening_mul(b);
    (product / denominator.to::<U512>()).saturating_to::<U256>()
}

pub fn bps_of(amount: U256, bps: u16) -> U256 {
    mul_div_down(amount, U256::from(bps), U256::from(BPS))
}

/// Where the vault's USDG currently sits.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Holdings {
    pub idle: U256,
    pub morpho: U256,
    pub uniswap: U256,
}

impl Holdings {
    pub fn total(&self) -> U256 {
        self.idle + self.morpho + self.uniswap
    }
}

/// Phase 1 of a rebalance: how much of the Uniswap position to unwind (in bps of it).
/// Returns 0 when the LP leg is at or below target. A zero target unwinds everything.
pub fn plan_unwind_bps(holdings: Holdings, uniswap_bps: u16, min_move: U256) -> u16 {
    if holdings.uniswap.is_zero() {
        return 0;
    }
    let target = bps_of(holdings.total(), uniswap_bps);
    if target.is_zero() {
        return BPS as u16;
    }
    if holdings.uniswap <= target || holdings.uniswap - target < min_move {
        return 0;
    }
    let excess = holdings.uniswap - target;
    // Round up so the leg lands at (not above) target.
    let numerator = excess * U256::from(BPS) + holdings.uniswap - U256::from(1);
    let bps = numerator / holdings.uniswap;
    bps.min(U256::from(BPS)).to::<u16>()
}

/// Phase 2 of a rebalance, computed after the unwind settled (real proceeds known).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Moves {
    pub morpho_withdraw: U256,
    /// Withdraw the whole Morpho position by shares (avoids dust).
    pub morpho_withdraw_all: bool,
    pub morpho_supply: U256,
    pub uniswap_deploy: U256,
}

pub fn plan_moves(holdings: Holdings, morpho_bps: u16, uniswap_bps: u16, min_move: U256) -> Moves {
    let total = holdings.total();
    let target_morpho = bps_of(total, morpho_bps);
    let target_uniswap = bps_of(total, uniswap_bps);
    let mut moves = Moves::default();

    if holdings.morpho > target_morpho {
        let excess = holdings.morpho - target_morpho;
        if target_morpho.is_zero() {
            moves.morpho_withdraw_all = true;
            moves.morpho_withdraw = holdings.morpho;
        } else if excess >= min_move {
            moves.morpho_withdraw = excess;
        }
    }

    let mut available = holdings.idle + moves.morpho_withdraw;
    if target_uniswap > holdings.uniswap {
        let want = target_uniswap - holdings.uniswap;
        let deploy = want.min(available);
        if deploy >= min_move {
            moves.uniswap_deploy = deploy;
            available -= deploy;
        }
    }
    if target_morpho > holdings.morpho {
        let want = target_morpho - holdings.morpho;
        let supply = want.min(available);
        if supply >= min_move {
            moves.morpho_supply = supply;
        }
    }
    moves
}

/// `true` when the rebalance lost no more than `max_loss_bps` of NAV.
pub fn nav_within_tolerance(before: U256, after: U256, max_loss_bps: u16) -> bool {
    if after >= before {
        return true;
    }
    let floor = mul_div_down(before, U256::from(BPS - u64::from(max_loss_bps)), U256::from(BPS));
    after >= floor
}

/// Bps of the LP position to unwind so a redemption can be paid in full (+1% buffer).
pub fn unwind_bps_for_shortfall(shortfall: U256, uniswap_value: U256) -> u16 {
    if uniswap_value.is_zero() || shortfall >= uniswap_value {
        return BPS as u16;
    }
    let with_buffer = shortfall * U256::from(101) / U256::from(100);
    let numerator = with_buffer * U256::from(BPS) + uniswap_value - U256::from(1);
    (numerator / uniswap_value).min(U256::from(BPS)).to::<u16>()
}

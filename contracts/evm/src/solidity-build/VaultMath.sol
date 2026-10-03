// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Solidity port of `contracts/stylus/vault/src/math.rs` (allocation planning).
///         Kept line-for-line equivalent so both builds rebalance identically.
library VaultMath {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MORPHO_VIRTUAL_SHARES = 1e6;
    uint256 internal constant MORPHO_VIRTUAL_ASSETS = 1;

    struct Holdings {
        uint256 idle;
        uint256 morpho;
        uint256 uniswap;
    }

    struct Moves {
        uint256 morphoWithdraw;
        bool morphoWithdrawAll;
        uint256 morphoSupply;
        uint256 uniswapDeploy;
    }

    function total(Holdings memory h) internal pure returns (uint256) {
        return h.idle + h.morpho + h.uniswap;
    }

    function bpsOf(uint256 amount, uint256 bps) internal pure returns (uint256) {
        return Math.mulDiv(amount, bps, BPS);
    }

    function morphoSharesToAssets(uint256 shares, uint256 totalSupplyAssets, uint256 totalSupplyShares)
        internal
        pure
        returns (uint256)
    {
        return Math.mulDiv(
            shares, totalSupplyAssets + MORPHO_VIRTUAL_ASSETS, totalSupplyShares + MORPHO_VIRTUAL_SHARES
        );
    }

    function planUnwindBps(Holdings memory h, uint256 uniswapBps, uint256 minMove) internal pure returns (uint256) {
        if (h.uniswap == 0) return 0;
        uint256 target = bpsOf(total(h), uniswapBps);
        if (target == 0) return BPS;
        if (h.uniswap <= target || h.uniswap - target < minMove) return 0;
        uint256 excess = h.uniswap - target;
        uint256 bps = (excess * BPS + h.uniswap - 1) / h.uniswap;
        return bps > BPS ? BPS : bps;
    }

    function planMoves(Holdings memory h, uint256 morphoBps, uint256 uniswapBps, uint256 minMove)
        internal
        pure
        returns (Moves memory moves)
    {
        uint256 t = total(h);
        uint256 targetMorpho = bpsOf(t, morphoBps);
        uint256 targetUniswap = bpsOf(t, uniswapBps);

        if (h.morpho > targetMorpho) {
            uint256 excess = h.morpho - targetMorpho;
            if (targetMorpho == 0) {
                moves.morphoWithdrawAll = true;
                moves.morphoWithdraw = h.morpho;
            } else if (excess >= minMove) {
                moves.morphoWithdraw = excess;
            }
        }

        uint256 available = h.idle + moves.morphoWithdraw;
        if (targetUniswap > h.uniswap) {
            uint256 deploy = Math.min(targetUniswap - h.uniswap, available);
            if (deploy >= minMove) {
                moves.uniswapDeploy = deploy;
                available -= deploy;
            }
        }
        if (targetMorpho > h.morpho) {
            uint256 supply = Math.min(targetMorpho - h.morpho, available);
            if (supply >= minMove) moves.morphoSupply = supply;
        }
    }

    function navWithinTolerance(uint256 before, uint256 afterNav, uint256 maxLossBps) internal pure returns (bool) {
        if (afterNav >= before) return true;
        return afterNav >= Math.mulDiv(before, BPS - maxLossBps, BPS);
    }

    function unwindBpsForShortfall(uint256 shortfall, uint256 uniswapValue) internal pure returns (uint256) {
        if (uniswapValue == 0 || shortfall >= uniswapValue) return BPS;
        uint256 withBuffer = shortfall * 101 / 100;
        uint256 bps = (withBuffer * BPS + uniswapValue - 1) / uniswapValue;
        return bps > BPS ? BPS : bps;
    }
}

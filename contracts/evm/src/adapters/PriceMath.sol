// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "v4-core/libraries/FullMath.sol";

/// @notice Conversions between a v4 pool's sqrtPriceX96 and a USD price with 8 decimals,
///         for a Stock Token / USDG pair (USDG ~ 1 USD).
library PriceMath {
    uint256 internal constant Q64 = 1 << 64;
    uint256 internal constant Q128 = 1 << 128;
    uint256 internal constant Q192 = 1 << 192;

    /// @return priceE8 Stock price in USDG with 8 decimals implied by the pool's sqrt price.
    function poolPriceE8(uint160 sqrtPriceX96, bool usdgIsCurrency0, uint8 usdgDecimals, uint8 stockDecimals)
        internal
        pure
        returns (uint256 priceE8)
    {
        uint256 scale = 10 ** (8 + uint256(stockDecimals) - uint256(usdgDecimals));
        if (usdgIsCurrency0) {
            // raw price = token1/token0 = stockWei per usdgWei -> invert.
            return FullMath.mulDiv(Q192 / sqrtPriceX96, scale, sqrtPriceX96);
        }
        // raw price = usdgWei per stockWei.
        uint256 priceX128 = FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, Q64);
        return FullMath.mulDiv(priceX128, scale, Q128);
    }

    /// @return value USDG (raw units) worth of `stockAmount` at `priceE8`.
    function stockValue(uint256 stockAmount, uint256 priceE8, uint8 usdgDecimals, uint8 stockDecimals)
        internal
        pure
        returns (uint256 value)
    {
        return FullMath.mulDiv(stockAmount, priceE8 * 10 ** usdgDecimals, 10 ** (uint256(stockDecimals) + 8));
    }

    /// @return sqrtPriceX96 Pool sqrt price that corresponds to a stock price of `priceE8` USDG.
    function sqrtPriceX96FromPriceE8(uint256 priceE8, bool usdgIsCurrency0, uint8 usdgDecimals, uint8 stockDecimals)
        internal
        pure
        returns (uint160)
    {
        uint256 stockUnit = 10 ** uint256(stockDecimals);
        uint256 usdgPerStock = priceE8 * 10 ** uint256(usdgDecimals); // scaled by 1e8
        uint256 ratioX192 = usdgIsCurrency0
            ? FullMath.mulDiv(stockUnit * 1e8, Q192, usdgPerStock) // token1/token0 = stock per usdg
            : FullMath.mulDiv(usdgPerStock, Q192, stockUnit * 1e8); // usdg per stock
        return uint160(_sqrt(ratioX192));
    }

    function _sqrt(uint256 x) private pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x;
        uint256 y = (x >> 1) + 1;
        while (y < z) {
            z = y;
            y = (x / y + y) >> 1;
        }
    }

    /// @return deviationBps |a - b| / b in basis points.
    function deviationBps(uint256 a, uint256 b) internal pure returns (uint256) {
        if (b == 0) return type(uint256).max;
        uint256 diff = a > b ? a - b : b - a;
        return diff * 10_000 / b;
    }
}

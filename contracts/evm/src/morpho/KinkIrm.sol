// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IIrm} from "morpho-blue/interfaces/IIrm.sol";
import {MarketParams, Market} from "morpho-blue/interfaces/IMorpho.sol";

/// @notice Utilization-kink interest rate model for the testnet Morpho Blue market.
///         Mainnet Robinhood Chain uses Morpho's AdaptiveCurveIrm; this deterministic model
///         keeps the demo's lending APY predictable.
contract KinkIrm is IIrm {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant SECONDS_PER_YEAR = 365 days;

    uint256 public immutable baseApr;
    uint256 public immutable kinkApr;
    uint256 public immutable maxApr;
    uint256 public immutable kinkUtilization;

    constructor(uint256 baseApr_, uint256 kinkApr_, uint256 maxApr_, uint256 kinkUtilization_) {
        require(baseApr_ <= kinkApr_ && kinkApr_ <= maxApr_, "KinkIrm: curve");
        require(kinkUtilization_ > 0 && kinkUtilization_ < WAD, "KinkIrm: kink");
        baseApr = baseApr_;
        kinkApr = kinkApr_;
        maxApr = maxApr_;
        kinkUtilization = kinkUtilization_;
    }

    function borrowRate(MarketParams memory, Market memory market) external view returns (uint256) {
        return _ratePerSecond(market);
    }

    function borrowRateView(MarketParams memory, Market memory market) external view returns (uint256) {
        return _ratePerSecond(market);
    }

    /// @notice Borrow APR (WAD) at a given utilization (WAD).
    function aprAt(uint256 utilization) public view returns (uint256) {
        if (utilization <= kinkUtilization) {
            return baseApr + (kinkApr - baseApr) * utilization / kinkUtilization;
        }
        uint256 excess = utilization > WAD ? WAD - kinkUtilization : utilization - kinkUtilization;
        return kinkApr + (maxApr - kinkApr) * excess / (WAD - kinkUtilization);
    }

    function _ratePerSecond(Market memory market) internal view returns (uint256) {
        uint256 utilization =
            market.totalSupplyAssets == 0 ? 0 : uint256(market.totalBorrowAssets) * WAD / market.totalSupplyAssets;
        return aprAt(utilization) / SECONDS_PER_YEAR;
    }
}

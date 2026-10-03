// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IOracle} from "morpho-blue/interfaces/IOracle.sol";

/// @notice Testnet reference price for a Stock Token in USD (8 decimals, Chainlink-style).
///         Robinhood Chain testnet has no Chainlink stock feeds; on mainnet this is replaced
///         by the token's Chainlink feed (e.g. "RHNVDA / USD").
///         Also implements Morpho's `IOracle` for a market where the stock is collateral
///         and USDG is the loan token.
contract StockPriceOracle is Ownable, IOracle {
    uint8 public constant decimals = 8;

    /// @dev 10^(36 + loanDecimals - collateralDecimals - 8), Morpho price scaling.
    uint256 public immutable morphoScale;

    int256 private _answer;
    uint256 private _updatedAt;
    uint80 private _roundId;

    event PriceUpdated(int256 answer, uint80 roundId);

    error InvalidPrice();

    constructor(address owner_, int256 initialPriceE8, uint8 loanDecimals, uint8 collateralDecimals) Ownable(owner_) {
        morphoScale = 10 ** (36 + uint256(loanDecimals) - uint256(collateralDecimals) - decimals);
        _setPrice(initialPriceE8);
    }

    function setPrice(int256 priceE8) external onlyOwner {
        _setPrice(priceE8);
    }

    function latestAnswer() external view returns (int256) {
        return _answer;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }

    /// @inheritdoc IOracle
    function price() external view returns (uint256) {
        return uint256(_answer) * morphoScale;
    }

    function _setPrice(int256 priceE8) private {
        if (priceE8 <= 0) revert InvalidPrice();
        _answer = priceE8;
        _updatedAt = block.timestamp;
        _roundId += 1;
        emit PriceUpdated(priceE8, _roundId);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "v4-core/libraries/TransientStateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {LiquidityAmounts} from "v4-core-test/utils/LiquidityAmounts.sol";
import {PriceMath} from "./PriceMath.sol";

interface IPriceFeed {
    function latestAnswer() external view returns (int256);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title UniV4LiquidityAdapter
/// @notice Holds the vault's Uniswap v4 Stock Token/USDG liquidity. Only the vault can move
///         funds. `deploy` swaps half the USDG into the stock and adds full-range liquidity;
///         `unwind` removes liquidity, sells the stock back and returns USDG to the vault.
///         Every action checks the pool price against the reference oracle first, so a
///         manipulated pool cannot be used to drain the vault (sandwich / LVR guard).
contract UniV4LiquidityAdapter is IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;

    enum Action {
        Deploy,
        Unwind
    }

    uint256 public constant BPS = 10_000;
    bytes32 public constant POSITION_SALT = bytes32(0);

    IPoolManager public immutable poolManager;
    address public immutable vault;
    IERC20 public immutable usdg;
    IERC20 public immutable stock;
    IPriceFeed public immutable oracle;
    bool public immutable usdgIsCurrency0;
    uint8 public immutable usdgDecimals;
    uint8 public immutable stockDecimals;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    address public immutable hooks;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;
    uint256 public immutable maxDeviationBps;
    /// @notice LP actions are refused when the reference price is older than this.
    uint256 public immutable maxOracleAge;

    event Deployed(uint256 usdgIn, uint256 stockBought, uint128 liquidityAdded);
    event Unwound(uint256 bps, uint128 liquidityRemoved, uint256 usdgOut);

    error OnlyVault();
    error OnlyPoolManager();
    error InvalidBps(uint256 bps);
    error PriceDeviation(uint256 poolPriceE8, uint256 oraclePriceE8);
    error InvalidOraclePrice();
    error StaleOraclePrice(uint256 updatedAt);

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    constructor(
        IPoolManager poolManager_,
        address vault_,
        IERC20 usdg_,
        IERC20 stock_,
        IPriceFeed oracle_,
        uint24 fee_,
        int24 tickSpacing_,
        address hooks_,
        uint256 maxDeviationBps_,
        uint256 maxOracleAge_
    ) {
        poolManager = poolManager_;
        vault = vault_;
        usdg = usdg_;
        stock = stock_;
        oracle = oracle_;
        usdgIsCurrency0 = address(usdg_) < address(stock_);
        usdgDecimals = IERC20Metadata(address(usdg_)).decimals();
        stockDecimals = IERC20Metadata(address(stock_)).decimals();
        fee = fee_;
        tickSpacing = tickSpacing_;
        hooks = hooks_;
        tickLower = (TickMath.MIN_TICK / tickSpacing_) * tickSpacing_;
        tickUpper = (TickMath.MAX_TICK / tickSpacing_) * tickSpacing_;
        maxDeviationBps = maxDeviationBps_;
        maxOracleAge = maxOracleAge_;
    }

    // ------------------------------------------------------------------ views

    function poolKey() public view returns (PoolKey memory) {
        (address c0, address c1) = usdgIsCurrency0 ? (address(usdg), address(stock)) : (address(stock), address(usdg));
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(hooks)
        });
    }

    function positionLiquidity() public view returns (uint128 liquidity) {
        (liquidity,,) = poolManager.getPositionInfo(poolKey().toId(), address(this), tickLower, tickUpper, POSITION_SALT);
    }

    function poolPriceE8() public view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolKey().toId());
        return PriceMath.poolPriceE8(sqrtPriceX96, usdgIsCurrency0, usdgDecimals, stockDecimals);
    }

    function oraclePriceE8() public view returns (uint256) {
        int256 answer = oracle.latestAnswer();
        if (answer <= 0) revert InvalidOraclePrice();
        return uint256(answer);
    }

    /// @notice Fair USDG value of the position + balances held here.
    /// @dev Manipulation-resistant: the position's token split is computed at the ORACLE price,
    ///      never at the pool's spot price, so moving the pool cannot move the vault's NAV.
    ///      Deliberately no staleness revert here: NAV reads gate redemptions, which must never block.
    function totalValue() external view returns (uint256) {
        uint128 liquidity = positionLiquidity();
        uint256 usdgAmount = usdg.balanceOf(address(this));
        uint256 stockAmount = stock.balanceOf(address(this));
        if (liquidity == 0 && stockAmount == 0) return usdgAmount;
        uint256 priceE8 = oraclePriceE8();
        if (liquidity > 0) {
            uint160 fairSqrtPrice = PriceMath.sqrtPriceX96FromPriceE8(priceE8, usdgIsCurrency0, usdgDecimals, stockDecimals);
            (uint256 amount0, uint256 amount1) = LiquidityAmounts.getAmountsForLiquidity(
                fairSqrtPrice, TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), liquidity
            );
            (uint256 usdgInLp, uint256 stockInLp) = usdgIsCurrency0 ? (amount0, amount1) : (amount1, amount0);
            usdgAmount += usdgInLp;
            stockAmount += stockInLp;
        }
        return usdgAmount + PriceMath.stockValue(stockAmount, priceE8, usdgDecimals, stockDecimals);
    }

    // ------------------------------------------------------------------ vault actions

    function deploy(uint256 amount) external onlyVault returns (uint256 liquidityAdded) {
        _checkPrice();
        usdg.safeTransferFrom(vault, address(this), amount);
        bytes memory result = poolManager.unlock(abi.encode(Action.Deploy, amount));
        liquidityAdded = abi.decode(result, (uint256));
    }

    function unwind(uint256 bps) external onlyVault returns (uint256 assetsOut) {
        if (bps == 0 || bps > BPS) revert InvalidBps(bps);
        _checkPrice();
        bytes memory result = poolManager.unlock(abi.encode(Action.Unwind, bps));
        assetsOut = abi.decode(result, (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        (Action action, uint256 value) = abi.decode(data, (Action, uint256));
        if (action == Action.Deploy) return abi.encode(_deploy(value));
        return abi.encode(_unwind(value));
    }

    // ------------------------------------------------------------------ internals

    function _deploy(uint256 amount) internal returns (uint256) {
        PoolKey memory key = poolKey();
        uint256 half = amount / 2;
        uint256 stockBought = _swapExactIn(key, true, half);

        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        uint256 usdgLeft = amount - half;
        (uint256 amount0, uint256 amount1) = usdgIsCurrency0 ? (usdgLeft, stockBought) : (stockBought, usdgLeft);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96, TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), amount0, amount1
        );
        if (liquidity > 0) {
            poolManager.modifyLiquidity(
                key,
                IPoolManager.ModifyLiquidityParams({
                    tickLower: tickLower,
                    tickUpper: tickUpper,
                    liquidityDelta: int256(uint256(liquidity)),
                    salt: POSITION_SALT
                }),
                ""
            );
        }
        _settleAll(key, address(this));
        emit Deployed(amount, stockBought, liquidity);
        return liquidity;
    }

    function _unwind(uint256 bps) internal returns (uint256) {
        PoolKey memory key = poolKey();
        uint128 liquidity = positionLiquidity();
        uint128 toRemove = bps == BPS ? liquidity : uint128(uint256(liquidity) * bps / BPS);
        if (toRemove > 0) {
            poolManager.modifyLiquidity(
                key,
                IPoolManager.ModifyLiquidityParams({
                    tickLower: tickLower,
                    tickUpper: tickUpper,
                    liquidityDelta: -int256(uint256(toRemove)),
                    salt: POSITION_SALT
                }),
                ""
            );
        }
        // Sweep dust left over from previous deploys into the exit as well.
        uint256 stockHeld = stock.balanceOf(address(this));
        if (stockHeld > 0) {
            poolManager.sync(Currency.wrap(address(stock)));
            stock.safeTransfer(address(poolManager), stockHeld);
            poolManager.settle();
        }
        int256 stockCredit = poolManager.currencyDelta(address(this), Currency.wrap(address(stock)));
        if (stockCredit > 0) _swapExactIn(key, false, uint256(stockCredit));

        int256 usdgCredit = poolManager.currencyDelta(address(this), Currency.wrap(address(usdg)));
        uint256 usdgOut = usdgCredit > 0 ? uint256(usdgCredit) : 0;
        _settleAll(key, vault);
        uint256 usdgHeld = usdg.balanceOf(address(this));
        if (usdgHeld > 0) {
            usdg.safeTransfer(vault, usdgHeld);
            usdgOut += usdgHeld;
        }
        emit Unwound(bps, toRemove, usdgOut);
        return usdgOut;
    }

    /// @dev Exact-input swap; `usdgIn` selects the direction. Returns the output amount.
    function _swapExactIn(PoolKey memory key, bool usdgIn, uint256 amountIn) internal returns (uint256) {
        if (amountIn == 0) return 0;
        bool zeroForOne = usdgIn == usdgIsCurrency0;
        poolManager.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        Currency out = Currency.wrap(usdgIn ? address(stock) : address(usdg));
        int256 delta = poolManager.currencyDelta(address(this), out);
        return delta > 0 ? uint256(delta) : 0;
    }

    /// @dev Pays every debt to the PoolManager and takes every credit to `recipient`.
    function _settleAll(PoolKey memory key, address recipient) internal {
        _settleCurrency(key.currency0, recipient);
        _settleCurrency(key.currency1, recipient);
    }

    function _settleCurrency(Currency currency, address recipient) internal {
        int256 delta = poolManager.currencyDelta(address(this), currency);
        if (delta < 0) {
            poolManager.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), uint256(-delta));
            poolManager.settle();
        } else if (delta > 0) {
            poolManager.take(currency, recipient, uint256(delta));
        }
    }

    function _checkPrice() internal view {
        (,,, uint256 updatedAt,) = oracle.latestRoundData();
        if (block.timestamp > updatedAt + maxOracleAge) revert StaleOraclePrice(updatedAt);
        uint256 poolPrice = poolPriceE8();
        uint256 oraclePrice = oraclePriceE8();
        if (PriceMath.deviationBps(poolPrice, oraclePrice) > maxDeviationBps) {
            revert PriceDeviation(poolPrice, oraclePrice);
        }
    }
}

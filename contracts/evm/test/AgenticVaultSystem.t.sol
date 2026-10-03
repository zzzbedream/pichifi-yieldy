// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core-test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {LiquidityAmounts} from "v4-core-test/utils/LiquidityAmounts.sol";
import {IMorpho, MarketParams, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TestToken} from "../src/mocks/TestToken.sol";
import {StockPriceOracle} from "../src/oracles/StockPriceOracle.sol";
import {KinkIrm} from "../src/morpho/KinkIrm.sol";
import {DynamicFeeHook} from "../src/hooks/DynamicFeeHook.sol";
import {IFeeEngine} from "../src/interfaces/IFeeEngine.sol";
import {UniV4LiquidityAdapter, IPriceFeed} from "../src/adapters/UniV4LiquidityAdapter.sol";
import {PriceMath} from "../src/adapters/PriceMath.sol";
import {AgenticVaultSol} from "../src/solidity-build/AgenticVaultSol.sol";
import {FeeEngineSol} from "../src/solidity-build/FeeEngineSol.sol";
import {EcdsaVerifierSol} from "../src/solidity-build/EcdsaVerifierSol.sol";

/// @notice End-to-end system test of the full stack the Stylus TestVM cannot exercise:
///         USDG deposit -> signed intent -> Uniswap v4 LP (dynamic-fee hook) + Morpho Blue ->
///         volatility regime raises swap fees -> risk-off moves 100% to Morpho -> redeem.
contract AgenticVaultSystemTest is Test, Deployers {
    using StateLibrary for IPoolManager;

    uint256 internal constant PRICE_E8 = 180e8; // 1 rhNVDA = 180 USDG
    uint256 internal constant LLTV = 0.77e18;
    uint256 internal agentKey = 0xA11CE;
    address internal guardian = address(0x6A2D);
    address internal investor = address(0x1A55);
    address internal borrower = address(0xB0B);

    TestToken internal usdg;
    TestToken internal stock;
    StockPriceOracle internal oracle;
    KinkIrm internal irm;
    IMorpho internal morpho;
    FeeEngineSol internal feeEngine;
    DynamicFeeHook internal hook;
    EcdsaVerifierSol internal verifier;
    AgenticVaultSol internal vault;
    UniV4LiquidityAdapter internal adapter;
    PoolKey internal poolKey;
    bool internal usdgIs0;

    function setUp() public {
        deployFreshManagerAndRouters();
        vm.warp(1_790_000_000);

        usdg = new TestToken("Global Dollar (Testnet Mock)", "USDG", 6, address(this));
        stock = new TestToken("NVIDIA Stock Token (Testnet, No Real Value)", "rhNVDA", 18, address(this));
        oracle = new StockPriceOracle(address(this), int256(PRICE_E8), 6, 18);
        usdgIs0 = address(usdg) < address(stock);

        _deployMorpho();
        feeEngine = new FeeEngineSol(address(this), 3_000, 50_000, 2);
        _deployHookAndPool();

        verifier = new EcdsaVerifierSol(address(this), vm.addr(agentKey));
        vault = new AgenticVaultSol(
            address(this), guardian, IERC20(address(usdg)), address(verifier), address(feeEngine),
            morpho, address(stock), address(oracle), address(irm), LLTV
        );
        adapter = new UniV4LiquidityAdapter(
            manager, address(vault), IERC20(address(usdg)), IERC20(address(stock)), IPriceFeed(address(oracle)),
            LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, address(hook), 1_000
        );
        vault.setAdapter(address(adapter));
        feeEngine.setUpdater(address(vault));

        usdg.mint(investor, 100_000e6);
        vm.startPrank(investor);
        usdg.approve(address(vault), type(uint256).max);
        vault.deposit(100_000e6, investor);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ setup helpers

    function _deployMorpho() internal {
        morpho = IMorpho(deployCode("Morpho.sol:Morpho", abi.encode(address(this))));
        irm = new KinkIrm(0.02e18, 0.08e18, 0.6e18, 0.9e18);
        morpho.enableIrm(address(irm));
        morpho.enableLltv(LLTV);
        MarketParams memory params = _market();
        morpho.createMarket(params);

        // Borrower creates utilization so suppliers earn yield.
        stock.mint(borrower, 2_000e18);
        usdg.mint(address(this), 300_000e6);
        usdg.approve(address(morpho), type(uint256).max);
        morpho.supply(params, 200_000e6, 0, address(this), "");
        vm.startPrank(borrower);
        stock.approve(address(morpho), type(uint256).max);
        morpho.supplyCollateral(params, 2_000e18, borrower, "");
        morpho.borrow(params, 150_000e6, 0, borrower, borrower);
        vm.stopPrank();
    }

    function _market() internal view returns (MarketParams memory) {
        return MarketParams({
            loanToken: address(usdg),
            collateralToken: address(stock),
            oracle: address(oracle),
            irm: address(irm),
            lltv: LLTV
        });
    }

    function _deployHookAndPool() internal {
        address hookAddress = address(uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG) ^ (0x4444 << 144));
        deployCodeTo("DynamicFeeHook.sol:DynamicFeeHook", abi.encode(manager, IFeeEngine(address(feeEngine))), hookAddress);
        hook = DynamicFeeHook(hookAddress);

        (Currency c0, Currency c1) = usdgIs0
            ? (Currency.wrap(address(usdg)), Currency.wrap(address(stock)))
            : (Currency.wrap(address(stock)), Currency.wrap(address(usdg)));
        poolKey = PoolKey(c0, c1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(hookAddress));
        uint160 sqrtPrice = PriceMath.sqrtPriceX96FromPriceE8(PRICE_E8, usdgIs0, 6, 18);
        manager.initialize(poolKey, sqrtPrice);

        // Third-party seed liquidity: 10M USDG + 55,555 rhNVDA full range (~$20M pool).
        usdg.mint(address(this), 13_000_000e6);
        stock.mint(address(this), 60_000e18);
        usdg.approve(address(modifyLiquidityRouter), type(uint256).max);
        stock.approve(address(modifyLiquidityRouter), type(uint256).max);
        usdg.approve(address(swapRouter), type(uint256).max);
        stock.approve(address(swapRouter), type(uint256).max);
        (uint256 a0, uint256 a1) = usdgIs0 ? (uint256(10_000_000e6), uint256(55_555e18)) : (uint256(55_555e18), uint256(10_000_000e6));
        int24 lower = (TickMath.MIN_TICK / 60) * 60;
        int24 upper = (TickMath.MAX_TICK / 60) * 60;
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPrice, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), a0, a1
        );
        modifyLiquidityRouter.modifyLiquidity(
            poolKey,
            IPoolManager.ModifyLiquidityParams(lower, upper, int256(uint256(liquidity)), bytes32(0)),
            ""
        );
    }

    function _execute(uint8 regime, uint16 morphoBps, uint16 uniswapBps, uint16 volBps) internal {
        uint64 nonce = vault.nonce();
        uint64 deadline = uint64(block.timestamp + 120);
        bytes32 inputsHash = keccak256(abi.encode(regime, morphoBps, uniswapBps, volBps));
        bytes32 modelVersion = keccak256("ayv-policy-v1");
        bytes32 digest = vault.intentDigest(nonce, deadline, regime, morphoBps, uniswapBps, volBps, inputsHash, modelVersion);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, digest);
        vault.executeIntent(nonce, deadline, regime, morphoBps, uniswapBps, volBps, inputsHash, modelVersion, abi.encodePacked(r, s, v));
    }

    function _swapUsdgForStock(uint256 amount) internal returns (int256 stockOut) {
        bool zeroForOne = usdgIs0;
        uint256 before = stock.balanceOf(address(this));
        swapRouter.swap(
            poolKey,
            IPoolManager.SwapParams(zeroForOne, -int256(amount), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        return int256(stock.balanceOf(address(this)) - before);
    }

    // ------------------------------------------------------------------ tests

    function test_depositMintsSharesAndKeepsUsdgIdle() public view {
        assertEq(vault.totalAssets(), 100_000e6);
        assertEq(vault.balanceOf(investor), 100_000e6 * 1e6);
        (uint256 idle, uint256 inMorpho, uint256 inLp) = vault.allocation();
        assertEq(idle, 100_000e6);
        assertEq(inMorpho + inLp, 0);
    }

    function test_riskOnSplitsBetweenUniswapAndMorpho() public {
        _execute(0, 5_000, 5_000, 0);
        (uint256 idle, uint256 inMorpho, uint256 inLp) = vault.allocation();
        assertApproxEqRel(inMorpho, 50_000e6, 0.001e18);
        assertApproxEqRel(inLp, 50_000e6, 0.02e18);
        assertLt(idle, 1_000e6);
        assertApproxEqRel(vault.totalAssets(), 100_000e6, 0.02e18);
        assertEq(vault.nonce(), 1);
        assertEq(feeEngine.currentFeePips(), 3_000);
    }

    function test_volatileRegimeRaisesSwapFeeChargedByHook() public {
        _execute(0, 5_000, 5_000, 0);
        int256 outCalm = _swapUsdgForStock(1_000e6);
        _swapStockBack(uint256(outCalm));

        vm.warp(block.timestamp + 31);
        _execute(1, 6_000, 4_000, 4_000); // fee = 3,000 + 4,000 * 2 = 11,000 pips (1.1%)
        assertEq(feeEngine.currentFeePips(), 11_000);
        assertEq(hook.currentFee(), 11_000);
        int256 outVolatile = _swapUsdgForStock(1_000e6);
        assertLt(outVolatile, outCalm, "volatile swaps pay a higher fee");
    }

    function test_riskOffMovesEverythingToMorpho() public {
        _execute(0, 5_000, 5_000, 0);
        vm.warp(block.timestamp + 31);
        _execute(2, 10_000, 0, 0);
        (uint256 idle, uint256 inMorpho, uint256 inLp) = vault.allocation();
        assertEq(inLp, 0);
        assertEq(adapter.positionLiquidity(), 0);
        assertLt(idle, 1e6);
        assertApproxEqRel(inMorpho, 100_000e6, 0.02e18);
        assertEq(feeEngine.currentFeePips(), 50_000);
    }

    function test_morphoYieldAccruesToShareholders() public {
        _execute(2, 10_000, 0, 0);
        uint256 before = vault.totalAssets();
        vm.warp(block.timestamp + 30 days);
        morpho.accrueInterest(_market());
        assertGt(vault.totalAssets(), before, "lending yield increases NAV");
    }

    function test_redeemPullsFromMorphoAndLp() public {
        _execute(0, 5_000, 5_000, 0);
        uint256 shares = vault.balanceOf(investor);
        vm.prank(investor);
        uint256 assets = vault.redeem(shares, investor, investor);
        assertApproxEqRel(assets, 100_000e6, 0.03e18);
        assertEq(usdg.balanceOf(investor), assets);
        assertEq(vault.totalSupply(), 0);
    }

    function test_redeemWorksWhilePausedButIntentsDoNot() public {
        _execute(2, 10_000, 0, 0);
        vm.prank(guardian);
        vault.setPaused(true);
        vm.expectRevert(AgenticVaultSol.Paused.selector);
        this.executeIntentExternal(2, 10_000, 0, 0);
        uint256 shares = vault.balanceOf(investor) / 2;
        vm.prank(investor);
        uint256 assets = vault.redeem(shares, investor, investor);
        assertApproxEqRel(assets, 50_000e6, 0.01e18);
    }

    function test_rejectsIntentSignedByAnotherKey() public {
        uint64 deadline = uint64(block.timestamp + 120);
        bytes32 digest = vault.intentDigest(0, deadline, 2, 10_000, 0, 0, bytes32(0), bytes32(0));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, digest);
        vm.expectRevert(AgenticVaultSol.InvalidSignature.selector);
        vault.executeIntent(0, deadline, 2, 10_000, 0, 0, bytes32(0), bytes32(0), abi.encodePacked(r, s, v));
    }

    function test_rejectsReplayAndRateLimit() public {
        _execute(2, 10_000, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(AgenticVaultSol.RebalanceTooSoon.selector, uint64(block.timestamp + 30)));
        this.executeIntentExternal(2, 10_000, 0, 0);
    }

    function test_guardrailsRejectOversizedLpAndLpInRiskOff() public {
        vm.expectRevert(abi.encodeWithSelector(AgenticVaultSol.InvalidAllocation.selector, uint16(2_000), uint16(8_000)));
        this.executeIntentExternal(0, 2_000, 8_000, 0);
        vm.expectRevert(abi.encodeWithSelector(AgenticVaultSol.InvalidAllocation.selector, uint16(5_000), uint16(5_000)));
        this.executeIntentExternal(2, 5_000, 5_000, 0);
    }

    function test_adapterRejectsManipulatedPool() public {
        _swapUsdgForStock(2_500_000e6); // push the pool >10% above the oracle price
        vm.expectRevert();
        this.executeIntentExternal(0, 5_000, 5_000, 0);
    }

    function test_emergencyExitReturnsAllToIdle() public {
        _execute(0, 5_000, 5_000, 0);
        vm.prank(guardian);
        vault.emergencyExit();
        (uint256 idle, uint256 inMorpho, uint256 inLp) = vault.allocation();
        assertEq(inMorpho + inLp, 0);
        assertApproxEqRel(idle, 100_000e6, 0.02e18);
        assertTrue(vault.paused());
    }

    function test_onlyVaultCanMoveAdapterFunds() public {
        vm.expectRevert(UniV4LiquidityAdapter.OnlyVault.selector);
        adapter.deploy(1e6);
        vm.expectRevert(UniV4LiquidityAdapter.OnlyVault.selector);
        adapter.unwind(10_000);
    }

    /// @dev External wrapper so `vm.expectRevert` can target the signed-intent call.
    function executeIntentExternal(uint8 regime, uint16 morphoBps, uint16 uniswapBps, uint16 volBps) external {
        _execute(regime, morphoBps, uniswapBps, volBps);
    }

    function _swapStockBack(uint256 amount) internal {
        bool zeroForOne = !usdgIs0;
        swapRouter.swap(
            poolKey,
            IPoolManager.SwapParams(zeroForOne, -int256(amount), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }
}

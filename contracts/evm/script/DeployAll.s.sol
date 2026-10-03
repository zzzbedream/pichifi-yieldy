// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolModifyLiquidityTest} from "v4-core/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {LiquidityAmounts} from "v4-core-test/utils/LiquidityAmounts.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {IMorpho, MarketParams} from "morpho-blue/interfaces/IMorpho.sol";

import {TestToken} from "../src/mocks/TestToken.sol";
import {StockPriceOracle} from "../src/oracles/StockPriceOracle.sol";
import {KinkIrm} from "../src/morpho/KinkIrm.sol";
import {DynamicFeeHook} from "../src/hooks/DynamicFeeHook.sol";
import {IFeeEngine} from "../src/interfaces/IFeeEngine.sol";
import {UniV4LiquidityAdapter, IPriceFeed} from "../src/adapters/UniV4LiquidityAdapter.sol";
import {PriceMath} from "../src/adapters/PriceMath.sol";
import {AgenticVaultSol} from "../src/solidity-build/AgenticVaultSol.sol";
import {FeeEngineSol} from "../src/solidity-build/FeeEngineSol.sol";
import {AmadeusBlsVerifierSol} from "../src/solidity-build/AmadeusBlsVerifierSol.sol";
import {EcdsaVerifierSol} from "../src/solidity-build/EcdsaVerifierSol.sol";

/// @notice One-shot deployment of the full Agentic Yield Vaults stack on Robinhood Chain
///         testnet (or any chain with a v4 PoolManager), writing every address to
///         `deployments/<network>.json`.
///
///   forge script script/DeployAll.s.sol --rpc-url $RPC_URL --broadcast --slow
///
/// Env: DEPLOYER_PRIVATE_KEY, GUARDIAN_ADDRESS, POOL_MANAGER (default: Robinhood v4),
///      USDG_ADDRESS (optional; a labelled mock is deployed when empty), NETWORK_NAME.
contract DeployAll is Script {
    address internal constant ROBINHOOD_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    uint256 internal constant PRICE_E8 = 180e8;
    uint256 internal constant LLTV = 0.77e18;
    int24 internal constant TICK_SPACING = 60;

    struct Deployment {
        address usdg;
        address stock;
        address oracle;
        address morpho;
        address irm;
        address feeEngine;
        address hook;
        address poolManager;
        address liquidityRouter;
        address swapRouter;
        address blsVerifier;
        address ecdsaVerifier;
        address vault;
        address adapter;
        bytes32 poolId;
        bytes32 marketId;
    }

    Deployment internal d;
    address internal deployer;
    address internal guardian;
    string internal identity;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        deployer = vm.addr(pk);
        guardian = vm.envOr("GUARDIAN_ADDRESS", deployer);
        identity = vm.readFile("../../deployments/agent-identity.json");
        d.poolManager = vm.envOr("POOL_MANAGER", ROBINHOOD_POOL_MANAGER);

        vm.startBroadcast(pk);
        _deployTokens();
        _deployMorpho();
        _deployFeeEngineAndHook();
        _deployPool();
        _deployVault();
        vm.stopBroadcast();

        _write();
    }

    function _deployTokens() internal {
        d.usdg = vm.envOr("USDG_ADDRESS", address(0));
        if (d.usdg == address(0)) {
            d.usdg = address(new TestToken("Global Dollar (Testnet Mock)", "USDG", 6, deployer, 1_000_000e6));
            TestToken(d.usdg).mint(deployer, 25_000_000e6);
        }
        d.stock = address(new TestToken("NVIDIA Stock Token (Testnet, No Real Value)", "rhNVDA", 18, deployer, 0));
        TestToken(d.stock).mint(deployer, 200_000e18);
        d.oracle = address(new StockPriceOracle(deployer, int256(PRICE_E8), 6, 18));
    }

    function _deployMorpho() internal {
        d.morpho = vm.deployCode("Morpho.sol:Morpho", abi.encode(deployer));
        d.irm = address(new KinkIrm(0.02e18, 0.08e18, 0.6e18, 0.9e18));
        IMorpho morpho = IMorpho(d.morpho);
        morpho.enableIrm(d.irm);
        morpho.enableLltv(LLTV);
        MarketParams memory params = MarketParams(d.usdg, d.stock, d.oracle, d.irm, LLTV);
        morpho.createMarket(params);
        d.marketId = keccak256(abi.encode(params));

        // Seed lenders and borrowers so suppliers (the vault) earn a real lending yield.
        IERC20(d.usdg).approve(d.morpho, type(uint256).max);
        IERC20(d.stock).approve(d.morpho, type(uint256).max);
        morpho.supply(params, 2_000_000e6, 0, deployer, "");
        morpho.supplyCollateral(params, 20_000e18, deployer, "");
        morpho.borrow(params, 1_500_000e6, 0, deployer, deployer);
    }

    function _deployFeeEngineAndHook() internal {
        d.feeEngine = address(new FeeEngineSol(deployer, 3_000, 50_000, 2));
        uint160 flags = uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);
        bytes memory args = abi.encode(IPoolManager(d.poolManager), IFeeEngine(d.feeEngine));
        (address expected, bytes32 salt) = HookMiner.find(CREATE2_FACTORY, flags, type(DynamicFeeHook).creationCode, args);
        DynamicFeeHook hook = new DynamicFeeHook{salt: salt}(IPoolManager(d.poolManager), IFeeEngine(d.feeEngine));
        require(address(hook) == expected, "hook address mismatch");
        d.hook = address(hook);
    }

    function _poolKey() internal view returns (PoolKey memory key, bool usdgIs0) {
        usdgIs0 = d.usdg < d.stock;
        (Currency c0, Currency c1) =
            usdgIs0 ? (Currency.wrap(d.usdg), Currency.wrap(d.stock)) : (Currency.wrap(d.stock), Currency.wrap(d.usdg));
        key = PoolKey(c0, c1, LPFeeLibrary.DYNAMIC_FEE_FLAG, TICK_SPACING, IHooks(d.hook));
    }

    function _deployPool() internal {
        IPoolManager manager = IPoolManager(d.poolManager);
        (PoolKey memory key, bool usdgIs0) = _poolKey();
        uint160 sqrtPrice = PriceMath.sqrtPriceX96FromPriceE8(PRICE_E8, usdgIs0, 6, 18);
        manager.initialize(key, sqrtPrice);
        d.poolId = keccak256(abi.encode(key));

        d.liquidityRouter = address(new PoolModifyLiquidityTest(manager));
        d.swapRouter = address(new PoolSwapTest(manager));
        IERC20(d.usdg).approve(d.liquidityRouter, type(uint256).max);
        IERC20(d.stock).approve(d.liquidityRouter, type(uint256).max);
        IERC20(d.usdg).approve(d.swapRouter, type(uint256).max);
        IERC20(d.stock).approve(d.swapRouter, type(uint256).max);

        // ~$20M full-range seed liquidity (10M USDG + 55,555 rhNVDA at $180).
        int24 lower = (TickMath.MIN_TICK / TICK_SPACING) * TICK_SPACING;
        int24 upper = (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING;
        (uint256 a0, uint256 a1) =
            usdgIs0 ? (uint256(10_000_000e6), uint256(55_555e18)) : (uint256(55_555e18), uint256(10_000_000e6));
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPrice, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), a0, a1
        );
        PoolModifyLiquidityTest(d.liquidityRouter).modifyLiquidity(
            key, IPoolManager.ModifyLiquidityParams(lower, upper, int256(uint256(liquidity)), bytes32(0)), ""
        );
    }

    function _deployVault() internal {
        d.blsVerifier = address(
            new AmadeusBlsVerifierSol(
                deployer,
                vm.parseJsonBytes(identity, ".blsPublicKeyUncompressed"),
                vm.parseJsonBytes(identity, ".blsPublicKeyCompressed"),
                vm.parseJsonBytes(identity, ".blsDst")
            )
        );
        d.ecdsaVerifier = address(new EcdsaVerifierSol(deployer, vm.parseJsonAddress(identity, ".ecdsaSigner")));

        AgenticVaultSol vault = new AgenticVaultSol(
            deployer, guardian, IERC20(d.usdg), d.blsVerifier, d.feeEngine, IMorpho(d.morpho), d.stock, d.oracle, d.irm, LLTV
        );
        d.vault = address(vault);
        d.adapter = address(
            new UniV4LiquidityAdapter(
                IPoolManager(d.poolManager),
                d.vault,
                IERC20(d.usdg),
                IERC20(d.stock),
                IPriceFeed(d.oracle),
                LPFeeLibrary.DYNAMIC_FEE_FLAG,
                TICK_SPACING,
                d.hook,
                1_000,
                30 days
            )
        );
        vault.setAdapter(d.adapter);
        FeeEngineSol(d.feeEngine).setUpdater(d.vault);
    }

    function _write() internal {
        string memory o = "deployment";
        vm.serializeString(o, "network", vm.envOr("NETWORK_NAME", string("robinhood-testnet")));
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeString(o, "build", "solidity (ABI-identical to contracts/stylus; Stylus activations paused)");
        vm.serializeAddress(o, "vault", d.vault);
        vm.serializeAddress(o, "feeEngine", d.feeEngine);
        vm.serializeAddress(o, "blsVerifier", d.blsVerifier);
        vm.serializeAddress(o, "ecdsaVerifier", d.ecdsaVerifier);
        vm.serializeAddress(o, "adapter", d.adapter);
        vm.serializeAddress(o, "hook", d.hook);
        vm.serializeAddress(o, "poolManager", d.poolManager);
        vm.serializeAddress(o, "liquidityRouter", d.liquidityRouter);
        vm.serializeAddress(o, "swapRouter", d.swapRouter);
        vm.serializeAddress(o, "usdg", d.usdg);
        vm.serializeAddress(o, "stockToken", d.stock);
        vm.serializeAddress(o, "oracle", d.oracle);
        vm.serializeAddress(o, "morpho", d.morpho);
        vm.serializeAddress(o, "irm", d.irm);
        vm.serializeBytes32(o, "poolId", d.poolId);
        vm.serializeBytes32(o, "marketId", d.marketId);
        vm.serializeAddress(o, "deployer", deployer);
        string memory json = vm.serializeAddress(o, "guardian", guardian);
        string memory path = string.concat("../../deployments/", vm.envOr("NETWORK_NAME", string("robinhood-testnet")), ".json");
        vm.writeJson(json, path);
        console2.log("deployment written to", path);
        console2.log("vault", d.vault);
    }
}

//! ABI of every contract the vault talks to. Calls are ABI-encoded with alloy's `sol!`
//! and dispatched through the Stylus `call` / `static_call` helpers.

use alloy_sol_types::sol;

sol! {
    interface IERC20 {
        function balanceOf(address account) external view returns (uint256);
        function transfer(address to, uint256 amount) external returns (bool);
        function transferFrom(address from, address to, uint256 amount) external returns (bool);
        function approve(address spender, uint256 amount) external returns (bool);
    }

    /// Morpho Blue (isolated lending markets).
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }

    interface IMorpho {
        function supply(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data)
            external returns (uint256 assetsSupplied, uint256 sharesSupplied);
        function withdraw(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver)
            external returns (uint256 assetsWithdrawn, uint256 sharesWithdrawn);
        function accrueInterest(MarketParams marketParams) external;
        function position(bytes32 id, address user)
            external view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);
        function market(bytes32 id)
            external view returns (
                uint128 totalSupplyAssets,
                uint128 totalSupplyShares,
                uint128 totalBorrowAssets,
                uint128 totalBorrowShares,
                uint128 lastUpdate,
                uint128 fee
            );
    }

    /// Solidity adapter that owns the Uniswap v4 Stock Token/USDG LP position.
    interface ILiquidityAdapter {
        function totalValue() external view returns (uint256);
        function deploy(uint256 amount) external returns (uint256 liquidityAdded);
        function unwind(uint256 bps) external returns (uint256 assetsOut);
    }

    /// AmadeusBlsVerifier / EcdsaVerifier.
    interface IIntentVerifier {
        function verify(bytes32 digest, bytes signature) external view returns (bool);
    }

    /// Rust fee logic read by the Uniswap v4 DynamicFeeHook.
    interface IFeeEngine {
        function setRegime(uint8 regime, uint16 volBps) external;
    }
}

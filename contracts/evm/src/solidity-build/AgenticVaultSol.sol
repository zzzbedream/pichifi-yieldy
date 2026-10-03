// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IMorpho, MarketParams, Market, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {VaultMath} from "./VaultMath.sol";

interface IIntentVerifier {
    function verify(bytes32 digest, bytes calldata signature) external view returns (bool);
}

interface IFeeEngineWriter {
    function setRegime(uint8 regime, uint16 volBps) external;
}

interface ILiquidityAdapter {
    function totalValue() external view returns (uint256);
    function deploy(uint256 amount) external returns (uint256);
    function unwind(uint256 bps) external returns (uint256);
}

/// @title AgenticVaultSol
/// @notice ABI-identical Solidity build of the Rust/Stylus `AgenticVault`
///         (contracts/stylus/vault). Deployed while Stylus activations are paused network-wide
///         (Arbitrum Security Council action, 2026-10-02); the agent and dashboard switch to the
///         Stylus deployment by address once activations resume. Same rules: funds move only
///         through `executeIntent`, signed by the agent's Amadeus key and checked on-chain.
contract AgenticVaultSol is ERC4626, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using VaultMath for VaultMath.Holdings;

    uint8 public constant REGIME_RISK_ON = 0;
    uint8 public constant REGIME_VOLATILE = 1;
    uint8 public constant REGIME_RISK_OFF = 2;

    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "RebalanceIntent(address vault,uint64 nonce,uint64 deadline,uint8 regime,uint16 morphoBps,uint16 uniswapBps,uint16 volBps,bytes32 inputsHash,bytes32 modelVersion)"
    );

    struct Intent {
        uint64 nonce;
        uint64 deadline;
        uint8 regime;
        uint16 morphoBps;
        uint16 uniswapBps;
        uint16 volBps;
        bytes32 inputsHash;
        bytes32 modelVersion;
    }

    address private _owner;
    address private _guardian;
    bool private _paused;
    address private _verifier;
    address private immutable _feeEngine;
    address private _adapter;
    IMorpho private immutable _morpho;
    MarketParams private _market;
    bytes32 private immutable _marketId;

    uint64 private _nonce;
    uint64 private _lastRebalance;
    uint8 private _regime;
    uint16 private _targetMorphoBps;
    uint16 private _targetUniswapBps;
    bytes32 private _lastInputsHash;

    uint16 private _maxUniswapBps = 7_000;
    uint64 private _minRebalanceInterval = 30;
    uint16 private _maxNavLossBps = 300;
    uint256 private _minMove = 1e6;

    event IntentExecuted(
        uint64 indexed nonce,
        uint8 regime,
        uint16 morphoBps,
        uint16 uniswapBps,
        uint16 volBps,
        bytes32 inputsHash,
        bytes32 modelVersion,
        bytes32 digest
    );
    event Rebalanced(uint256 idle, uint256 morpho, uint256 uniswap, uint256 navBefore, uint256 navAfter);
    event GuardrailsUpdated(uint16 maxUniswapBps, uint64 minRebalanceInterval, uint16 maxNavLossBps, uint256 minMove);
    event VerifierChanged(address indexed previousVerifier, address indexed newVerifier);
    event AdapterSet(address indexed adapter);
    event GuardianChanged(address indexed previousGuardian, address indexed newGuardian);
    event PausedSet(bool paused);
    event EmergencyExit(uint256 idleAfter);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized(address caller);
    error ZeroAddress();
    error ZeroAmount();
    error Paused();
    error InsufficientLiquidity(uint256 have, uint256 want);
    error InvalidNonce(uint64 expected, uint64 got);
    error IntentExpired(uint64 deadline, uint64 nowTs);
    error RebalanceTooSoon(uint64 nextAllowed);
    error InvalidAllocation(uint16 morphoBps, uint16 uniswapBps);
    error InvalidSignature();
    error AdapterNotSet();
    error AdapterAlreadySet();
    error NavLossExceeded(uint256 navBefore, uint256 navAfter);

    modifier onlyOwner() {
        if (msg.sender != _owner) revert Unauthorized(msg.sender);
        _;
    }

    modifier onlyGuardianOrOwner() {
        if (msg.sender != _owner && msg.sender != _guardian) revert Unauthorized(msg.sender);
        _;
    }

    modifier whenNotPaused() {
        if (_paused) revert Paused();
        _;
    }

    constructor(
        address owner_,
        address guardian_,
        IERC20 asset_,
        address verifier_,
        address feeEngine_,
        IMorpho morpho_,
        address marketCollateral,
        address marketOracle,
        address marketIrm,
        uint256 marketLltv
    ) ERC20("Agentic Yield Vault USDG", "ayvUSDG") ERC4626(asset_) EIP712("AgenticYieldVault", "1") {
        if (
            owner_ == address(0) || guardian_ == address(0) || address(asset_) == address(0)
                || verifier_ == address(0) || feeEngine_ == address(0) || address(morpho_) == address(0)
        ) revert ZeroAddress();
        _owner = owner_;
        _guardian = guardian_;
        _verifier = verifier_;
        _feeEngine = feeEngine_;
        _morpho = morpho_;
        _market = MarketParams({
            loanToken: address(asset_),
            collateralToken: marketCollateral,
            oracle: marketOracle,
            irm: marketIrm,
            lltv: marketLltv
        });
        _marketId = keccak256(abi.encode(_market));
    }

    // ------------------------------------------------------------------ ERC-4626

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    function totalAssets() public view override returns (uint256) {
        return _holdings().total();
    }

    function maxDeposit(address) public view override returns (uint256) {
        return _paused ? 0 : type(uint256).max;
    }

    function maxMint(address) public view override returns (uint256) {
        return _paused ? 0 : type(uint256).max;
    }

    function deposit(uint256 assets, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        if (assets == 0) revert ZeroAmount();
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        if (shares == 0) revert ZeroAmount();
        return super.mint(shares, receiver);
    }

    /// @dev Redemptions work while paused so depositors can always exit. If unwinding the LP
    ///      realizes less than its oracle value (swap fees/impact), the redeemer receives what
    ///      was realized, within the `maxNavLossBps` guardrail — never the other holders.
    function redeem(uint256 shares, address receiver, address owner_) public override nonReentrant returns (uint256) {
        if (shares == 0) revert ZeroAmount();
        uint256 maxShares = maxRedeem(owner_);
        if (shares > maxShares) revert ERC4626ExceededMaxRedeem(owner_, shares, maxShares);
        return _exit(_msgSender(), receiver, owner_, previewRedeem(shares), shares, true);
    }

    /// @dev Exact-assets exit: reverts unless the full amount can be sourced.
    function withdraw(uint256 assets, address receiver, address owner_)
        public
        override
        nonReentrant
        returns (uint256)
    {
        uint256 maxAssets = maxWithdraw(owner_);
        if (assets > maxAssets) revert ERC4626ExceededMaxWithdraw(owner_, assets, maxAssets);
        uint256 shares = previewWithdraw(assets);
        _exit(_msgSender(), receiver, owner_, assets, shares, false);
        return shares;
    }

    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
    {
        _exit(caller, receiver, owner_, assets, shares, false);
    }

    /// @dev Burns first, then sources liquidity (Morpho first, then the LP leg) and pays out.
    function _exit(
        address caller,
        address receiver,
        address owner_,
        uint256 assets,
        uint256 shares,
        bool allowSlippage
    ) internal returns (uint256 paid) {
        if (caller != owner_) _spendAllowance(owner_, caller, shares);
        _burn(owner_, shares);
        paid = _ensureLiquidity(assets, allowSlippage);
        IERC20(asset()).safeTransfer(receiver, paid);
        emit Withdraw(caller, receiver, owner_, paid, shares);
    }

    function allocation() external view returns (uint256 idle, uint256 morpho, uint256 uniswap) {
        VaultMath.Holdings memory h = _holdings();
        return (h.idle, h.morpho, h.uniswap);
    }

    // ------------------------------------------------------------------ agent intents

    function nonce() external view returns (uint64) {
        return _nonce;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function intentDigest(
        uint64 nonce_,
        uint64 deadline,
        uint8 regime,
        uint16 morphoBps,
        uint16 uniswapBps,
        uint16 volBps,
        bytes32 inputsHash,
        bytes32 modelVersion
    ) external view returns (bytes32) {
        return _digest(Intent(nonce_, deadline, regime, morphoBps, uniswapBps, volBps, inputsHash, modelVersion));
    }

    function agentState() external view returns (uint8, uint16, uint16, uint64, bytes32) {
        return (_regime, _targetMorphoBps, _targetUniswapBps, _lastRebalance, _lastInputsHash);
    }

    /// @notice Verifies the agent's signed intent and rebalances. Anyone may relay it.
    function executeIntent(
        uint64 nonce_,
        uint64 deadline,
        uint8 regime,
        uint16 morphoBps,
        uint16 uniswapBps,
        uint16 volBps,
        bytes32 inputsHash,
        bytes32 modelVersion,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        Intent memory intent = Intent(nonce_, deadline, regime, morphoBps, uniswapBps, volBps, inputsHash, modelVersion);
        _checkIntent(intent);
        bytes32 digest = _digest(intent);
        if (!IIntentVerifier(_verifier).verify(digest, signature)) revert InvalidSignature();

        _nonce = nonce_ + 1;
        _lastRebalance = uint64(block.timestamp);
        _regime = regime;
        _targetMorphoBps = morphoBps;
        _targetUniswapBps = uniswapBps;
        _lastInputsHash = inputsHash;

        _rebalance(morphoBps, uniswapBps, true);
        IFeeEngineWriter(_feeEngine).setRegime(regime, volBps);
        emit IntentExecuted(nonce_, regime, morphoBps, uniswapBps, volBps, inputsHash, modelVersion, digest);
    }

    // ------------------------------------------------------------------ admin & safety

    function wiring() external view returns (address, address, address, address, address, address) {
        return (_owner, _guardian, _verifier, _feeEngine, _adapter, address(_morpho));
    }

    function marketId() external view returns (bytes32) {
        return _marketId;
    }

    function guardrails() external view returns (uint16, uint64, uint16, uint256) {
        return (_maxUniswapBps, _minRebalanceInterval, _maxNavLossBps, _minMove);
    }

    function paused() external view returns (bool) {
        return _paused;
    }

    function setAdapter(address adapter) external onlyOwner {
        if (adapter == address(0)) revert ZeroAddress();
        if (_adapter != address(0)) revert AdapterAlreadySet();
        _adapter = adapter;
        emit AdapterSet(adapter);
    }

    function setVerifier(address verifier) external onlyOwner {
        if (verifier == address(0)) revert ZeroAddress();
        emit VerifierChanged(_verifier, verifier);
        _verifier = verifier;
    }

    function setGuardrails(uint16 maxUniswapBps, uint64 minRebalanceInterval, uint16 maxNavLossBps, uint256 minMove)
        external
        onlyOwner
    {
        if (maxUniswapBps > VaultMath.BPS || maxNavLossBps > VaultMath.BPS) {
            revert InvalidAllocation(maxNavLossBps, maxUniswapBps);
        }
        (_maxUniswapBps, _minRebalanceInterval, _maxNavLossBps, _minMove) =
            (maxUniswapBps, minRebalanceInterval, maxNavLossBps, minMove);
        emit GuardrailsUpdated(maxUniswapBps, minRebalanceInterval, maxNavLossBps, minMove);
    }

    function setGuardian(address guardian) external onlyOwner {
        if (guardian == address(0)) revert ZeroAddress();
        emit GuardianChanged(_guardian, guardian);
        _guardian = guardian;
    }

    function setPaused(bool paused_) external onlyGuardianOrOwner {
        _paused = paused_;
        emit PausedSet(paused_);
    }

    /// @dev No NAV-loss bound: the guardian explicitly accepts the unwind cost to get out.
    function emergencyExit() external nonReentrant onlyGuardianOrOwner {
        _paused = true;
        emit PausedSet(true);
        _rebalance(0, 0, false);
        emit EmergencyExit(_idle());
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(_owner, newOwner);
        _owner = newOwner;
    }

    // ------------------------------------------------------------------ internals

    function _digest(Intent memory i) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    INTENT_TYPEHASH,
                    address(this),
                    i.nonce,
                    i.deadline,
                    i.regime,
                    i.morphoBps,
                    i.uniswapBps,
                    i.volBps,
                    i.inputsHash,
                    i.modelVersion
                )
            )
        );
    }

    function _checkIntent(Intent memory i) internal view {
        if (i.nonce != _nonce) revert InvalidNonce(_nonce, i.nonce);
        if (block.timestamp > i.deadline) revert IntentExpired(i.deadline, uint64(block.timestamp));
        uint64 nextAllowed = _lastRebalance + _minRebalanceInterval;
        if (_lastRebalance != 0 && block.timestamp < nextAllowed) revert RebalanceTooSoon(nextAllowed);
        bool riskOffWithLp = i.regime == REGIME_RISK_OFF && i.uniswapBps > 0;
        if (
            i.regime > REGIME_RISK_OFF || uint256(i.morphoBps) + i.uniswapBps > VaultMath.BPS
                || i.uniswapBps > _maxUniswapBps || riskOffWithLp
        ) revert InvalidAllocation(i.morphoBps, i.uniswapBps);
        if (i.uniswapBps > 0 && _adapter == address(0)) revert AdapterNotSet();
    }

    function _rebalance(uint256 morphoBps, uint256 uniswapBps, bool enforceNavBound) internal {
        _morphoAccrue();
        VaultMath.Holdings memory before = _holdings();

        uint256 unwindBps = VaultMath.planUnwindBps(before, uniswapBps, _minMove);
        if (unwindBps > 0) ILiquidityAdapter(_adapter).unwind(unwindBps);

        VaultMath.Moves memory moves = VaultMath.planMoves(_holdings(), morphoBps, uniswapBps, _minMove);
        if (moves.morphoWithdrawAll) _morphoWithdrawAll();
        else if (moves.morphoWithdraw > 0) _morpho.withdraw(_market, moves.morphoWithdraw, 0, address(this), address(this));
        if (moves.uniswapDeploy > 0) {
            IERC20(asset()).forceApprove(_adapter, moves.uniswapDeploy);
            ILiquidityAdapter(_adapter).deploy(moves.uniswapDeploy);
        }
        if (moves.morphoSupply > 0) {
            IERC20(asset()).forceApprove(address(_morpho), moves.morphoSupply);
            _morpho.supply(_market, moves.morphoSupply, 0, address(this), "");
        }

        VaultMath.Holdings memory afterH = _holdings();
        if (enforceNavBound && !VaultMath.navWithinTolerance(before.total(), afterH.total(), _maxNavLossBps)) {
            revert NavLossExceeded(before.total(), afterH.total());
        }
        emit Rebalanced(afterH.idle, afterH.morpho, afterH.uniswap, before.total(), afterH.total());
    }

    /// @return payable_ `assets`, or the realized amount when `allowSlippage` and within tolerance.
    function _ensureLiquidity(uint256 assets, bool allowSlippage) internal returns (uint256 payable_) {
        uint256 idle = _idle();
        if (idle >= assets) return assets;
        _morphoAccrue();
        uint256 inMorpho = _morphoAssets();
        if (inMorpho > 0) {
            if (inMorpho <= assets - idle) _morphoWithdrawAll();
            else _morpho.withdraw(_market, assets - idle, 0, address(this), address(this));
        }
        idle = _idle();
        if (idle >= assets) return assets;
        uint256 inLp = _adapterValue();
        if (inLp > 0) ILiquidityAdapter(_adapter).unwind(VaultMath.unwindBpsForShortfall(assets - idle, inLp));
        idle = _idle();
        if (idle >= assets) return assets;
        if (allowSlippage && VaultMath.navWithinTolerance(assets, idle, _maxNavLossBps)) return idle;
        revert InsufficientLiquidity(idle, assets);
    }

    function _holdings() internal view returns (VaultMath.Holdings memory) {
        return VaultMath.Holdings({idle: _idle(), morpho: _morphoAssets(), uniswap: _adapterValue()});
    }

    function _idle() internal view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    function _supplyShares() internal view returns (uint256) {
        return _morpho.position(Id.wrap(_marketId), address(this)).supplyShares;
    }

    function _morphoAssets() internal view returns (uint256) {
        uint256 shares = _supplyShares();
        if (shares == 0) return 0;
        Market memory m = _morpho.market(Id.wrap(_marketId));
        return VaultMath.morphoSharesToAssets(shares, m.totalSupplyAssets, m.totalSupplyShares);
    }

    function _morphoAccrue() internal {
        if (_supplyShares() > 0) _morpho.accrueInterest(_market);
    }

    function _morphoWithdrawAll() internal {
        uint256 shares = _supplyShares();
        if (shares > 0) _morpho.withdraw(_market, 0, shares, address(this), address(this));
    }

    function _adapterValue() internal view returns (uint256) {
        return _adapter == address(0) ? 0 : ILiquidityAdapter(_adapter).totalValue();
    }
}

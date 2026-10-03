// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title FeeEngineSol
/// @notice ABI-identical Solidity build of the Rust/Stylus `FeeEngine`
///         (contracts/stylus/fee-engine). Same schedule, same events, same errors.
contract FeeEngineSol {
    uint32 public constant MAX_LP_FEE = 1_000_000;
    uint8 public constant REGIME_RISK_ON = 0;
    uint8 public constant REGIME_VOLATILE = 1;
    uint8 public constant REGIME_RISK_OFF = 2;

    address public owner;
    address public updater;
    uint8 public regime;
    uint16 public volBps;
    uint32 private _baseFeePips;
    uint32 private _maxFeePips;
    uint32 private _slopePipsPerBps;

    event RegimeUpdated(uint8 regime, uint16 volBps, uint32 feePips);
    event ParamsUpdated(uint32 baseFeePips, uint32 maxFeePips, uint32 slopePipsPerBps);
    event UpdaterChanged(address indexed previousUpdater, address indexed newUpdater);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized(address caller);
    error InvalidRegime(uint8 regime);
    error InvalidParams(uint32 baseFeePips, uint32 maxFeePips);
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized(msg.sender);
        _;
    }

    constructor(address owner_, uint32 baseFeePips, uint32 maxFeePips, uint32 slopePipsPerBps) {
        if (owner_ == address(0)) revert ZeroAddress();
        _validate(baseFeePips, maxFeePips);
        owner = owner_;
        (_baseFeePips, _maxFeePips, _slopePipsPerBps) = (baseFeePips, maxFeePips, slopePipsPerBps);
    }

    function computeFee(uint8 regime_, uint16 volBps_, uint32 base, uint32 max, uint32 slope)
        public
        pure
        returns (uint32)
    {
        if (regime_ == REGIME_RISK_ON) return base;
        if (regime_ == REGIME_VOLATILE) {
            uint256 fee = uint256(base) + uint256(volBps_) * slope;
            return fee > max ? max : uint32(fee);
        }
        return max;
    }

    function currentFeePips() public view returns (uint32) {
        return computeFee(regime, volBps, _baseFeePips, _maxFeePips, _slopePipsPerBps);
    }

    function params() external view returns (uint32, uint32, uint32) {
        return (_baseFeePips, _maxFeePips, _slopePipsPerBps);
    }

    function setRegime(uint8 regime_, uint16 volBps_) external {
        if (msg.sender != updater) revert Unauthorized(msg.sender);
        if (regime_ > REGIME_RISK_OFF) revert InvalidRegime(regime_);
        (regime, volBps) = (regime_, volBps_);
        emit RegimeUpdated(regime_, volBps_, currentFeePips());
    }

    function setUpdater(address updater_) external onlyOwner {
        emit UpdaterChanged(updater, updater_);
        updater = updater_;
    }

    function setParams(uint32 baseFeePips, uint32 maxFeePips, uint32 slopePipsPerBps) external onlyOwner {
        _validate(baseFeePips, maxFeePips);
        (_baseFeePips, _maxFeePips, _slopePipsPerBps) = (baseFeePips, maxFeePips, slopePipsPerBps);
        emit ParamsUpdated(baseFeePips, maxFeePips, slopePipsPerBps);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function _validate(uint32 base, uint32 max) private pure {
        if (base > max || max > MAX_LP_FEE) revert InvalidParams(base, max);
    }
}

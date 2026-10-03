// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice ABI of the Rust/Stylus `FeeEngine` (and its ABI-identical Solidity build).
interface IFeeEngine {
    function currentFeePips() external view returns (uint32);
    function regime() external view returns (uint8);
    function volBps() external view returns (uint16);
    function setRegime(uint8 regime, uint16 volBps) external;
}

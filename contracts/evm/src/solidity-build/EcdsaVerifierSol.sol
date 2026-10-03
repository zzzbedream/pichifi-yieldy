// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title EcdsaVerifierSol
/// @notice ABI-identical Solidity build of the Rust/Stylus `EcdsaVerifier` (fallback scheme).
contract EcdsaVerifierSol {
    address public owner;
    address public signer;

    event SignerChanged(address indexed previousSigner, address indexed newSigner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized(address caller);
    error ZeroAddress();

    constructor(address owner_, address signer_) {
        if (owner_ == address(0) || signer_ == address(0)) revert ZeroAddress();
        owner = owner_;
        signer = signer_;
    }

    function verify(bytes32 digest, bytes calldata signature) external view returns (bool) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        return err == ECDSA.RecoverError.NoError && recovered == signer;
    }

    function scheme() external pure returns (string memory) {
        return "ECDSA-secp256k1";
    }

    function setSigner(address signer_) external {
        if (msg.sender != owner) revert Unauthorized(msg.sender);
        if (signer_ == address(0)) revert ZeroAddress();
        emit SignerChanged(signer, signer_);
        signer = signer_;
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert Unauthorized(msg.sender);
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}

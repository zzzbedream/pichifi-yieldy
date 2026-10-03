// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Testnet-only ERC-20 used where no official testnet token exists
///         (e.g. NVDA Stock Token) or when the official USDG faucet is insufficient.
///         The name always states "Testnet, No Real Value".
contract TestToken is ERC20, Ownable {
    uint8 private immutable _decimals;
    /// @notice Max amount per public `faucet` call (0 disables the public faucet).
    uint256 public immutable faucetCap;

    error FaucetDisabledOrAboveCap(uint256 requested, uint256 cap);

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address owner_, uint256 faucetCap_)
        ERC20(name_, symbol_)
        Ownable(owner_)
    {
        _decimals = decimals_;
        faucetCap = faucetCap_;
    }

    /// @notice Testnet faucet so judges and demo wallets can get tokens without the owner.
    function faucet(uint256 amount) external {
        if (amount == 0 || amount > faucetCap) revert FaucetDisabledOrAboveCap(amount, faucetCap);
        _mint(msg.sender, amount);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}

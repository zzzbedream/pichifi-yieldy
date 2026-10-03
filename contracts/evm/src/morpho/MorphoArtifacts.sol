// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.19;

// Forces Foundry to compile the canonical Morpho Blue contract (solc 0.8.19) so scripts and
// tests can deploy it with `vm.deployCode("Morpho.sol:Morpho", ...)` on testnets where
// Morpho has no official deployment (Robinhood Chain testnet).
import {Morpho} from "morpho-blue/Morpho.sol";

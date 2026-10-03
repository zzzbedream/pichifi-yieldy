// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {AmadeusBlsVerifierSol} from "../src/solidity-build/AmadeusBlsVerifierSol.sol";

/// @notice Uses the same vectors as the Rust verifier (agent/scripts/bls-vectors.ts), signed
///         with noble/curves, the library used by the Amadeus TypeScript SDK.
contract AmadeusBlsVerifierSolTest is Test {
    AmadeusBlsVerifierSol internal verifier;
    string internal json;

    function setUp() public {
        json = vm.readFile("../../agent/test/fixtures/bls-vectors.json");
        verifier = new AmadeusBlsVerifierSol(
            address(this),
            vm.parseJsonBytes(json, ".publicKeyUncompressed"),
            vm.parseJsonBytes(json, ".publicKeyCompressed"),
            bytes(vm.parseJsonString(json, ".dst"))
        );
    }

    function _digest() internal view returns (bytes32) {
        return vm.parseJsonBytes32(json, ".digest");
    }

    function _signature() internal view returns (bytes memory) {
        return vm.parseJsonBytes(json, ".signatureUncompressed");
    }

    function test_expandMessageXmdMatchesRfc9380Vector() public view {
        bytes memory uniform =
            verifier.expandMessageXmd(abi.encodePacked(_digest()), bytes(vm.parseJsonString(json, ".dst")));
        assertEq(uniform, vm.parseJsonBytes(json, ".uniformBytes"));
    }

    function test_verifiesAmadeusSignature() public view {
        assertTrue(verifier.verify(_digest(), _signature()));
    }

    function test_rejectsTamperedSignature() public view {
        bytes memory sig = _signature();
        sig[200] = bytes1(uint8(sig[200]) ^ 0x01);
        assertFalse(verifier.verify(_digest(), sig));
    }

    function test_rejectsOtherDigest() public view {
        assertFalse(verifier.verify(keccak256("other"), _signature()));
    }

    function test_rejectsCompressedOrEmptySignature() public view {
        assertFalse(verifier.verify(_digest(), vm.parseJsonBytes(json, ".signatureCompressed")));
        assertFalse(verifier.verify(_digest(), ""));
    }

    function test_onlyOwnerRotatesKey() public {
        bytes memory pk = vm.parseJsonBytes(json, ".publicKeyUncompressed");
        bytes memory pkc = vm.parseJsonBytes(json, ".publicKeyCompressed");
        vm.prank(address(0xBEEF));
        vm.expectRevert(abi.encodeWithSelector(AmadeusBlsVerifierSol.Unauthorized.selector, address(0xBEEF)));
        verifier.setPublicKey(pk, pkc);
        verifier.setPublicKey(pk, pkc);
        vm.expectRevert(AmadeusBlsVerifierSol.InvalidPublicKey.selector);
        verifier.setPublicKey(new bytes(128), pkc);
    }

    function test_metadata() public view {
        assertEq(verifier.scheme(), "BLS12-381-G2 (Amadeus)");
        assertEq(verifier.publicKeyCompressed(), vm.parseJsonBytes(json, ".publicKeyCompressed"));
        assertEq(verifier.owner(), address(this));
    }
}

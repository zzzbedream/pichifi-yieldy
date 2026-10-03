// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title AmadeusBlsVerifierSol
/// @notice ABI-identical Solidity build of the Rust/Stylus `AmadeusBlsVerifier`
///         (contracts/stylus/bls-verifier). Verifies Amadeus-native BLS12-381 "min_pk"
///         signatures (G1 pubkey, G2 signature) over a 32-byte digest using only precompiles:
///         SHA-256 (0x02) for RFC 9380 expand_message_xmd, MODEXP (0x05) for the mod-p
///         reduction, then EIP-2537 MAP_FP2_TO_G2 (0x11), G2ADD (0x0d), PAIRING_CHECK (0x0f).
contract AmadeusBlsVerifierSol {
    address internal constant MODEXP = address(0x05);
    address internal constant BLS12_G2ADD = address(0x0d);
    address internal constant BLS12_PAIRING_CHECK = address(0x0f);
    address internal constant BLS12_MAP_FP2_TO_G2 = address(0x11);

    /// @dev Gas caps: an invalid point makes a precompile consume all forwarded gas, so cap
    ///      each call (EIP-2537 costs: map 23,800; add 600; 2-pair check 102,900).
    uint256 internal constant MAP_GAS = 50_000;
    uint256 internal constant ADD_GAS = 10_000;
    uint256 internal constant PAIRING_GAS = 150_000;

    uint256 internal constant G1_LEN = 128;
    uint256 internal constant G2_LEN = 256;
    uint256 internal constant COMPRESSED_G1_LEN = 48;

    /// @dev BLS12-381 base field modulus p (48 bytes, big-endian).
    bytes internal constant P =
        hex"1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab";

    /// @dev EIP-2537 encoding of -G1 (negated generator).
    bytes internal constant NEG_G1 =
        hex"0000000000000000000000000000000017f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb00000000000000000000000000000000114d1d6855d545a8aa7d76c8cf2e21f267816aef1db507c96655b9d5caac42364e6f38ba0ecb751bad54dcd6b939c2ca";

    address public owner;
    bytes private _publicKey;
    bytes private _publicKeyCompressed;
    bytes private _dst;

    event PublicKeyChanged(bytes publicKeyCompressed);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized(address caller);
    error ZeroAddress();
    error InvalidPublicKey();
    error InvalidDst();

    constructor(address owner_, bytes memory publicKey_, bytes memory publicKeyCompressed_, bytes memory dst_) {
        if (owner_ == address(0)) revert ZeroAddress();
        if (dst_.length == 0 || dst_.length > 255) revert InvalidDst();
        owner = owner_;
        _dst = dst_;
        _storePublicKey(publicKey_, publicKeyCompressed_);
    }

    /// @notice True iff `signature` (uncompressed EIP-2537 G2) is a valid BLS signature of
    ///         `digest` by the configured Amadeus key. Never reverts on bad input.
    function verify(bytes32 digest, bytes calldata signature) external view returns (bool) {
        if (signature.length != G2_LEN) return false;
        (bool ok, bytes memory hashed) = _hashToG2(digest);
        if (!ok) return false;
        (bool okPair, bytes memory out) =
            BLS12_PAIRING_CHECK.staticcall{gas: PAIRING_GAS}(bytes.concat(NEG_G1, signature, _publicKey, hashed));
        return okPair && out.length == 32 && abi.decode(out, (uint256)) == 1;
    }

    /// @dev hash_to_curve(G2): expand_message_xmd -> hash_to_field -> map x2 -> add.
    function _hashToG2(bytes32 digest) internal view returns (bool, bytes memory) {
        (bytes memory u0, bytes memory u1) = _hashToField(expandMessageXmd(abi.encodePacked(digest), _dst));
        (bool ok0, bytes memory q0) = BLS12_MAP_FP2_TO_G2.staticcall{gas: MAP_GAS}(u0);
        if (!ok0 || q0.length != G2_LEN) return (false, "");
        (bool ok1, bytes memory q1) = BLS12_MAP_FP2_TO_G2.staticcall{gas: MAP_GAS}(u1);
        if (!ok1 || q1.length != G2_LEN) return (false, "");
        (bool okAdd, bytes memory hashed) = BLS12_G2ADD.staticcall{gas: ADD_GAS}(bytes.concat(q0, q1));
        return (okAdd && hashed.length == G2_LEN, hashed);
    }

    /// @notice RFC 9380 §5.3.1 expand_message_xmd (SHA-256), 256 output bytes.
    function expandMessageXmd(bytes memory message, bytes memory dstBytes) public pure returns (bytes memory uniform) {
        bytes memory dstPrime = bytes.concat(dstBytes, bytes1(uint8(dstBytes.length)));
        bytes32 b0 = sha256(bytes.concat(new bytes(64), message, hex"0100", hex"00", dstPrime));
        uniform = new bytes(256);
        bytes32 prev = sha256(bytes.concat(b0, hex"01", dstPrime));
        _write(uniform, 0, prev);
        for (uint256 i = 2; i <= 8; i++) {
            prev = sha256(bytes.concat(b0 ^ prev, bytes1(uint8(i)), dstPrime));
            _write(uniform, (i - 1) * 32, prev);
        }
    }

    function scheme() external pure returns (string memory) {
        return "BLS12-381-G2 (Amadeus)";
    }

    function publicKey() external view returns (bytes memory) {
        return _publicKey;
    }

    function publicKeyCompressed() external view returns (bytes memory) {
        return _publicKeyCompressed;
    }

    function dst() external view returns (bytes memory) {
        return _dst;
    }

    function setPublicKey(bytes calldata publicKey_, bytes calldata publicKeyCompressed_) external {
        if (msg.sender != owner) revert Unauthorized(msg.sender);
        _storePublicKey(publicKey_, publicKeyCompressed_);
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert Unauthorized(msg.sender);
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ------------------------------------------------------------------ internals

    /// @dev Four 64-byte chunks, each reduced mod p -> u0 = (e0, e1), u1 = (e2, e3).
    function _hashToField(bytes memory uniform) internal view returns (bytes memory u0, bytes memory u1) {
        u0 = bytes.concat(_reduce(uniform, 0), _reduce(uniform, 64));
        u1 = bytes.concat(_reduce(uniform, 128), _reduce(uniform, 192));
    }

    /// @dev OS2IP(64 bytes) mod p via MODEXP(base, 1, p), returned in 64-byte EIP-2537 form.
    function _reduce(bytes memory uniform, uint256 offset) internal view returns (bytes memory) {
        bytes memory chunk = new bytes(64);
        for (uint256 i = 0; i < 64; i++) {
            chunk[i] = uniform[offset + i];
        }
        bytes memory input = bytes.concat(bytes32(uint256(64)), bytes32(uint256(1)), bytes32(uint256(48)), chunk, hex"01", P);
        (bool ok, bytes memory reduced) = MODEXP.staticcall(input);
        require(ok && reduced.length == 48, "modexp");
        return bytes.concat(new bytes(16), reduced);
    }

    function _write(bytes memory target, uint256 offset, bytes32 word) private pure {
        assembly ("memory-safe") {
            mstore(add(add(target, 32), offset), word)
        }
    }

    function _storePublicKey(bytes memory uncompressed, bytes memory compressed) private {
        if (uncompressed.length != G1_LEN || compressed.length != COMPRESSED_G1_LEN || keccak256(uncompressed) == keccak256(new bytes(G1_LEN))) {
            revert InvalidPublicKey();
        }
        _publicKey = uncompressed;
        _publicKeyCompressed = compressed;
        emit PublicKeyChanged(compressed);
    }
}

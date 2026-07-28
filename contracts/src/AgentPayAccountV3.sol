// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @title AgentPayAccountV3
/// @notice UUPS-upgradeable AgentPay smart account. Payment execution still
///         requires an owner-signed EIP-712 direct or allowlisted route
///         authorization; the signature remains the payment proof.
/// @dev Successor to the non-upgradeable AgentPayAccountV2, which stays
///      deployed and untouched. A contract that shipped without a proxy cannot
///      retroactively become upgradeable, so this is a new implementation
///      intended to sit behind an ERC-1967 proxy.
///
///      Authorization moved from a single immutable `owner` to AccessControl
///      roles. That is not cosmetic: `immutable` values live in the
///      implementation's bytecode rather than in storage, so behind a proxy
///      they would read from the implementation and not the account. Every
///      former immutable is now storage set during `initialize`.
///
///      Role model:
///        DEFAULT_ADMIN_ROLE — grants and revokes the roles below
///        OWNER_ROLE        — signs payment authorizations, holds admin ops
///        EXECUTOR_ROLE     — submits an already-signed authorization
///        UPGRADER_ROLE     — authorizes an implementation upgrade
///
///      OWNER_ROLE is intentionally separate from UPGRADER_ROLE: an account
///      owner who can move funds should not, by that fact alone, be able to
///      replace the code that decides how funds move.
contract AgentPayAccountV3 is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    struct DirectPaymentAuthorization {
        bytes32 intentIdHash;
        bytes32 tenantIdHash;
        bytes32 paymentType;
        address owner;
        address account;
        address token;
        address recipient;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
        bytes32 purposeHash;
    }

    struct RoutePaymentAuthorization {
        bytes32 intentIdHash;
        bytes32 tenantIdHash;
        bytes32 paymentType;
        address owner;
        address account;
        address sourceToken;
        uint256 maxAmountIn;
        uint256 destinationChainId;
        address destinationToken;
        address recipient;
        uint256 minAmountOut;
        address routeTarget;
        bytes32 routeCalldataHash;
        uint256 maxNativeFee;
        uint256 nonce;
        uint256 deadline;
        bytes32 purposeHash;
    }

    error Paused();
    error CalldataHashMismatch();
    error DeadlineExpired(uint256 deadline);
    error DeadlineTooFar(uint256 deadline, uint256 maximum);
    error ExternalCallFailed(bytes reason);
    error ExecutorCannotBeOwner();
    error InsufficientTokenBalance(address token, uint256 required, uint256 available);
    error InvalidAmount();
    error InvalidDestinationChain();
    error InvalidDestinationToken();
    error InvalidRecipient();
    error InvalidSignature();
    error NativeFeeTooHigh(uint256 sent, uint256 maxAllowed);
    error NonceAlreadyUsed(uint256 nonce);
    error OwnerMustBeEOA();
    error Reentrancy();
    error RouteTargetNotAllowed(address target);
    error TokenNotAllowed(address token);
    error UpgradeToZeroAddress();
    error ZeroAddress();
    error RoleHolderMustBeEOA(bytes32 role, address account);
    error ConflictingRole(bytes32 role, address account);
    error AdminCannotBeOwner();

    event AuthorizedDirectPaymentExecuted(
        bytes32 indexed intentIdHash,
        bytes32 indexed authorizationHash,
        uint256 indexed nonce,
        address token,
        address recipient,
        uint256 amount
    );
    event AuthorizedRoutePaymentExecuted(
        bytes32 indexed intentIdHash,
        bytes32 indexed authorizationHash,
        uint256 indexed nonce,
        address sourceToken,
        address routeTarget,
        uint256 maxAmountIn,
        uint256 minAmountOut
    );
    event NonceCancelled(uint256 indexed nonce);
    event TokenAllowedUpdated(address indexed token, bool allowed);
    event RouteTargetAllowedUpdated(address indexed target, bool allowed);
    event WithdrawnToken(address indexed token, address indexed to, uint256 amount);
    event WithdrawnNative(address indexed to, uint256 amount);
    event AccountPaused();
    event AccountUnpaused();

    bytes32 public constant OWNER_ROLE = keccak256("AGENTPAY_OWNER_ROLE");
    bytes32 public constant EXECUTOR_ROLE = keccak256("AGENTPAY_EXECUTOR_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("AGENTPAY_UPGRADER_ROLE");

    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant DIRECT_PAYMENT_TYPEHASH = keccak256(
        "DirectPaymentAuthorization(bytes32 intentIdHash,bytes32 tenantIdHash,bytes32 paymentType,address owner,address account,address token,address recipient,uint256 amount,uint256 nonce,uint256 deadline,bytes32 purposeHash)"
    );
    bytes32 public constant ROUTE_PAYMENT_TYPEHASH = keccak256(
        "RoutePaymentAuthorization(bytes32 intentIdHash,bytes32 tenantIdHash,bytes32 paymentType,address owner,address account,address sourceToken,uint256 maxAmountIn,uint256 destinationChainId,address destinationToken,address recipient,uint256 minAmountOut,address routeTarget,bytes32 routeCalldataHash,uint256 maxNativeFee,uint256 nonce,uint256 deadline,bytes32 purposeHash)"
    );

    bytes32 private constant _NAME_HASH = keccak256("AgentPay");
    bytes32 private constant _VERSION_HASH = keccak256("1");
    bytes32 private constant _DIRECT_PAYMENT = keccak256("DIRECT_PAYMENT");
    bytes32 private constant _ROUTE_PAYMENT = keccak256("ROUTE_PAYMENT");

    uint256 private constant _DIRECT_DEADLINE_WINDOW = 15 minutes;
    uint256 private constant _ROUTE_DEADLINE_WINDOW = 5 minutes;
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private constant _SECP256K1_N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    bytes4 private constant _ERC1271_MAGIC_VALUE = 0x1626ba7e;
    bytes4 private constant _ERC1271_INVALID_VALUE = 0xffffffff;

    bool public paused;

    mapping(uint256 => bool) public usedNonces;
    mapping(address => bool) public allowedTokens;
    mapping(address => bool) public allowedRouteTargets;

    uint256 private _reentrancyStatus;

    /// @dev Reserved so a later implementation can add storage without
    ///      colliding with anything a future parent contract introduces.
    uint256[45] private __gap;

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyStatus == _ENTERED) revert Reentrancy();
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = _NOT_ENTERED;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // Without this, the implementation itself is left uninitialized and
        // anyone can call `initialize` on it directly. That is the most
        // frequently reported UUPS finding: an attacker takes the implementation's
        // admin roles and, with a `delegatecall` or `selfdestruct` reachable from
        // any future version, can brick every proxy pointing at it.
        _disableInitializers();
    }

    /// @notice Initializes the account behind its proxy.
    /// @dev `initialOwner` must be an EOA so the ERC-1271 and EIP-712 paths keep
    ///      recovering a key rather than delegating to another contract.
    function initialize(
        address defaultAdmin,
        address initialOwner,
        address initialExecutor,
        address initialUpgrader,
        address[] calldata initialAllowedTokens,
        address[] calldata initialAllowedRouteTargets
    ) external initializer {
        if (
            defaultAdmin == address(0) || initialOwner == address(0) || initialExecutor == address(0)
                || initialUpgrader == address(0)
        ) {
            revert ZeroAddress();
        }
        if (initialOwner.code.length != 0) revert OwnerMustBeEOA();
        if (initialOwner == initialExecutor) revert ExecutorCannotBeOwner();
        // The default admin can grant any role, so letting it also be the owner
        // silently collapses every separation below into one key.
        if (defaultAdmin == initialOwner) revert AdminCannotBeOwner();

        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, defaultAdmin);
        _grantRole(OWNER_ROLE, initialOwner);
        _grantRole(EXECUTOR_ROLE, initialExecutor);
        _grantRole(UPGRADER_ROLE, initialUpgrader);

        _reentrancyStatus = _NOT_ENTERED;

        for (uint256 index = 0; index < initialAllowedTokens.length; index++) {
            address token = initialAllowedTokens[index];
            if (token == address(0)) revert ZeroAddress();
            allowedTokens[token] = true;
            emit TokenAllowedUpdated(token, true);
        }

        for (uint256 index = 0; index < initialAllowedRouteTargets.length; index++) {
            address target = initialAllowedRouteTargets[index];
            if (target == address(0)) revert ZeroAddress();
            allowedRouteTargets[target] = true;
            emit RouteTargetAllowedUpdated(target, true);
        }
    }

    receive() external payable {}

    /// @dev Enforces the separations this contract documents, on every grant
    ///      rather than only at initialization. Without this, DEFAULT_ADMIN_ROLE
    ///      could hand OWNER_ROLE to a contract, or give one address both
    ///      OWNER_ROLE and UPGRADER_ROLE, making the stated split advisory.
    ///
    ///      What this does NOT do: constrain DEFAULT_ADMIN_ROLE itself. An admin
    ///      can still rotate role holders, so DEFAULT_ADMIN_ROLE remains fully
    ///      trusted by design. Give it to a timelock or multisig, never to the
    ///      same key that operates the account.
    function _grantRole(bytes32 role, address account) internal override returns (bool) {
        if (role == OWNER_ROLE) {
            if (account.code.length != 0) revert RoleHolderMustBeEOA(role, account);
            if (hasRole(UPGRADER_ROLE, account) || hasRole(EXECUTOR_ROLE, account)) {
                revert ConflictingRole(role, account);
            }
        }
        if (role == UPGRADER_ROLE && hasRole(OWNER_ROLE, account)) {
            revert ConflictingRole(role, account);
        }
        if (role == EXECUTOR_ROLE && hasRole(OWNER_ROLE, account)) {
            revert ConflictingRole(role, account);
        }

        return super._grantRole(role, account);
    }

    /// @dev Only UPGRADER_ROLE may replace the implementation. Deliberately not
    ///      OWNER_ROLE: moving funds and replacing the code that governs how
    ///      funds move are different powers.
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {
        if (newImplementation == address(0)) revert UpgradeToZeroAddress();
    }

    function domainSeparator() public view returns (bytes32) {
        // Recomputed per call rather than cached at construction: a cached
        // separator would be captured against the implementation's address and
        // the deploy-time chain id, both wrong behind a proxy and after a fork.
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this)));
    }

    function hashDirectAuthorization(DirectPaymentAuthorization calldata authorization)
        external
        view
        returns (bytes32)
    {
        return _hashDirectAuthorization(authorization);
    }

    function hashRouteAuthorization(RoutePaymentAuthorization calldata authorization) external view returns (bytes32) {
        return _hashRouteAuthorization(authorization);
    }

    /// @notice Validates arbitrary digests for ERC-1271 integrations such as
    ///         ERC-8004 agent-wallet ownership proofs.
    /// @dev Any OWNER_ROLE holder satisfies this, so granting OWNER_ROLE is
    ///      equivalent to granting signing authority over the account.
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        address signer = _tryRecover(digest, signature);
        return signer != address(0) && hasRole(OWNER_ROLE, signer) ? _ERC1271_MAGIC_VALUE : _ERC1271_INVALID_VALUE;
    }

    function setAllowedToken(address token, bool allowed) external onlyRole(OWNER_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        allowedTokens[token] = allowed;
        emit TokenAllowedUpdated(token, allowed);
    }

    function setAllowedRouteTarget(address target, bool allowed) external onlyRole(OWNER_ROLE) {
        if (target == address(0)) revert ZeroAddress();
        allowedRouteTargets[target] = allowed;
        emit RouteTargetAllowedUpdated(target, allowed);
    }

    function cancelNonce(uint256 nonce) external onlyRole(OWNER_ROLE) {
        if (usedNonces[nonce]) revert NonceAlreadyUsed(nonce);
        usedNonces[nonce] = true;
        emit NonceCancelled(nonce);
    }

    function pause() external onlyRole(OWNER_ROLE) {
        paused = true;
        emit AccountPaused();
    }

    function unpause() external onlyRole(OWNER_ROLE) {
        paused = false;
        emit AccountUnpaused();
    }

    function withdrawToken(address token, address to, uint256 amount) external onlyRole(OWNER_ROLE) {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();
        _safeTransfer(token, to, amount);
        emit WithdrawnToken(token, to, amount);
    }

    function withdrawNative(address payable to, uint256 amount) external onlyRole(OWNER_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();

        (bool success, bytes memory reason) = to.call{value: amount}("");
        if (!success) revert ExternalCallFailed(reason);
        emit WithdrawnNative(to, amount);
    }

    function executeAuthorizedDirectPayment(DirectPaymentAuthorization calldata authorization, bytes calldata signature)
        external
        onlyRole(EXECUTOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        bytes32 authorizationHash = _validateDirectAuthorization(authorization, signature);

        usedNonces[authorization.nonce] = true;
        _safeTransfer(authorization.token, authorization.recipient, authorization.amount);

        emit AuthorizedDirectPaymentExecuted(
            authorization.intentIdHash,
            authorizationHash,
            authorization.nonce,
            authorization.token,
            authorization.recipient,
            authorization.amount
        );
    }

    function executeAuthorizedRoutePayment(
        RoutePaymentAuthorization calldata authorization,
        bytes calldata routeCalldata,
        bytes calldata signature
    ) external payable onlyRole(EXECUTOR_ROLE) whenNotPaused nonReentrant {
        bytes32 authorizationHash = _validateRouteAuthorization(authorization, routeCalldata, signature);

        usedNonces[authorization.nonce] = true;
        _safeApprove(authorization.sourceToken, authorization.routeTarget, 0);
        _safeApprove(authorization.sourceToken, authorization.routeTarget, authorization.maxAmountIn);

        (bool success, bytes memory reason) = authorization.routeTarget.call{value: msg.value}(routeCalldata);
        if (!success) revert ExternalCallFailed(reason);

        _safeApprove(authorization.sourceToken, authorization.routeTarget, 0);

        emit AuthorizedRoutePaymentExecuted(
            authorization.intentIdHash,
            authorizationHash,
            authorization.nonce,
            authorization.sourceToken,
            authorization.routeTarget,
            authorization.maxAmountIn,
            authorization.minAmountOut
        );
    }

    function _validateDirectAuthorization(DirectPaymentAuthorization calldata authorization, bytes calldata signature)
        private
        view
        returns (bytes32 authorizationHash)
    {
        // The payload still names its signer, and that named signer must both
        // hold OWNER_ROLE and be the address the signature recovers to. Checking
        // only the role would let one owner's signature be replayed inside
        // another owner's payload.
        if (!hasRole(OWNER_ROLE, authorization.owner) || authorization.account != address(this)) {
            revert InvalidSignature();
        }
        if (authorization.paymentType != _DIRECT_PAYMENT) revert InvalidSignature();
        if (!allowedTokens[authorization.token]) revert TokenNotAllowed(authorization.token);
        if (authorization.recipient == address(0)) revert InvalidRecipient();
        if (authorization.amount == 0) revert InvalidAmount();
        _validateNonceAndDeadline(authorization.nonce, authorization.deadline, _DIRECT_DEADLINE_WINDOW);
        _requireTokenBalance(authorization.token, authorization.amount);

        authorizationHash = _hashDirectAuthorization(authorization);
        if (_recover(authorizationHash, signature) != authorization.owner) revert InvalidSignature();
    }

    function _validateRouteAuthorization(
        RoutePaymentAuthorization calldata authorization,
        bytes calldata routeCalldata,
        bytes calldata signature
    ) private view returns (bytes32 authorizationHash) {
        if (!hasRole(OWNER_ROLE, authorization.owner) || authorization.account != address(this)) {
            revert InvalidSignature();
        }
        if (authorization.paymentType != _ROUTE_PAYMENT) revert InvalidSignature();
        if (!allowedTokens[authorization.sourceToken]) revert TokenNotAllowed(authorization.sourceToken);
        if (authorization.recipient == address(0)) revert InvalidRecipient();
        if (authorization.destinationChainId == 0) revert InvalidDestinationChain();
        if (authorization.destinationToken == address(0)) revert InvalidDestinationToken();
        if (authorization.maxAmountIn == 0 || authorization.minAmountOut == 0) revert InvalidAmount();
        if (!allowedRouteTargets[authorization.routeTarget]) {
            revert RouteTargetNotAllowed(authorization.routeTarget);
        }
        if (authorization.routeCalldataHash != keccak256(routeCalldata)) revert CalldataHashMismatch();
        if (msg.value > authorization.maxNativeFee) {
            revert NativeFeeTooHigh(msg.value, authorization.maxNativeFee);
        }
        _validateNonceAndDeadline(authorization.nonce, authorization.deadline, _ROUTE_DEADLINE_WINDOW);
        _requireTokenBalance(authorization.sourceToken, authorization.maxAmountIn);

        authorizationHash = _hashRouteAuthorization(authorization);
        if (_recover(authorizationHash, signature) != authorization.owner) revert InvalidSignature();
    }

    function _validateNonceAndDeadline(uint256 nonce, uint256 deadline, uint256 maximumWindow) private view {
        if (usedNonces[nonce]) revert NonceAlreadyUsed(nonce);
        if (deadline <= block.timestamp) revert DeadlineExpired(deadline);

        uint256 maximum = block.timestamp + maximumWindow;
        if (deadline > maximum) revert DeadlineTooFar(deadline, maximum);
    }

    function _hashDirectAuthorization(DirectPaymentAuthorization calldata authorization)
        private
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                DIRECT_PAYMENT_TYPEHASH,
                authorization.intentIdHash,
                authorization.tenantIdHash,
                authorization.paymentType,
                authorization.owner,
                authorization.account,
                authorization.token,
                authorization.recipient,
                authorization.amount,
                authorization.nonce,
                authorization.deadline,
                authorization.purposeHash
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _hashRouteAuthorization(RoutePaymentAuthorization calldata authorization) private view returns (bytes32) {
        uint256[18] memory words;
        words[0] = uint256(ROUTE_PAYMENT_TYPEHASH);
        words[1] = uint256(authorization.intentIdHash);
        words[2] = uint256(authorization.tenantIdHash);
        words[3] = uint256(authorization.paymentType);
        words[4] = uint256(uint160(authorization.owner));
        words[5] = uint256(uint160(authorization.account));
        words[6] = uint256(uint160(authorization.sourceToken));
        words[7] = authorization.maxAmountIn;
        words[8] = authorization.destinationChainId;
        words[9] = uint256(uint160(authorization.destinationToken));
        words[10] = uint256(uint160(authorization.recipient));
        words[11] = authorization.minAmountOut;
        words[12] = uint256(uint160(authorization.routeTarget));
        words[13] = uint256(authorization.routeCalldataHash);
        words[14] = authorization.maxNativeFee;
        words[15] = authorization.nonce;
        words[16] = authorization.deadline;
        words[17] = uint256(authorization.purposeHash);
        bytes32 structHash = keccak256(abi.encode(words));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        signer = _tryRecover(digest, signature);
        if (signer == address(0)) revert InvalidSignature();
    }

    /// @dev Rejects the high-s malleable half so one authorization cannot be
    ///      presented twice under two distinct signatures.
    function _tryRecover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) return address(0);

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v != 27 && v != 28) return address(0);
        if (uint256(r) == 0) return address(0);
        if (uint256(s) == 0 || uint256(s) > _SECP256K1_N_HALF) return address(0);
        signer = ecrecover(digest, v, r, s);
    }

    function _requireTokenBalance(address token, uint256 required) private view {
        uint256 available = _tokenBalanceOf(token, address(this));
        if (available < required) revert InsufficientTokenBalance(token, required, available);
    }

    function _tokenBalanceOf(address token, address account) private view returns (uint256 balance) {
        (bool success, bytes memory data) = token.staticcall(abi.encodeWithSelector(IERC20.balanceOf.selector, account));
        if (!success || data.length < 32) revert ExternalCallFailed(data);
        balance = abi.decode(data, (uint256));
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        _requireOptionalReturn(success, data);
    }

    function _safeApprove(address token, address spender, uint256 amount) private {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        _requireOptionalReturn(success, data);
    }

    function _requireOptionalReturn(bool success, bytes memory data) private pure {
        if (!success || (data.length != 0 && (data.length != 32 || !abi.decode(data, (bool))))) {
            revert ExternalCallFailed(data);
        }
    }
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {IERC1822Proxiable} from "@openzeppelin/contracts/interfaces/draft-IERC1822.sol";

import {AgentPayAccountV3} from "./AgentPayAccountV3.sol";

/// @title AgentPayAccountV3ProxyFactory
/// @notice Deploys AgentPayAccountV3 accounts as ERC-1967 proxies at
///         deterministic addresses, each authorized by the owner it is created
///         for.
/// @dev Deploy permission alone is not authority to create an account. The
///      deployer supplies the transaction; the owner supplies an EIP-712
///      signature over the complete initialization policy. Without that binding
///      a compromised deployer could name a victim as owner, keep
///      DEFAULT_ADMIN_ROLE for itself, then grant itself OWNER_ROLE and drain
///      the account. This mirrors the owner-signed MainnetWalletSetup already
///      used by the production V1 factory.
///
///      The factory itself is intentionally NOT upgradeable. Its only job is to
///      create proxies; making it upgradeable would add an authority that can
///      change how every future account is created, for no benefit. Accounts
///      are upgradeable individually through their own UPGRADER_ROLE.
contract AgentPayAccountV3ProxyFactory is AccessControl {
    error ZeroAddress();
    error ImplementationNotUUPS();
    error AccountAlreadyDeployed(address account);
    error AuthorizationExpired(uint256 deadline);
    error InvalidOwnerAuthorization();

    event AccountDeployed(address indexed account, address indexed owner, address indexed executor, bytes32 salt);

    bytes32 public constant DEPLOYER_ROLE = keccak256("AGENTPAY_FACTORY_DEPLOYER_ROLE");

    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @dev Every field the owner is agreeing to. Anything omitted here is a
    ///      field the deployer could change unilaterally, which is precisely
    ///      the hole this signature closes.
    bytes32 public constant ACCOUNT_SETUP_TYPEHASH = keccak256(
        "AccountSetup(address factory,address implementation,uint256 chainId,bytes32 salt,address defaultAdmin,address owner,address executor,address upgrader,bytes32 allowedTokensHash,bytes32 allowedRouteTargetsHash,address predictedAccount,uint256 deadline)"
    );

    bytes32 private constant _NAME_HASH = keccak256("AgentPayAccountV3ProxyFactory");
    bytes32 private constant _VERSION_HASH = keccak256("1");
    uint256 private constant _SECP256K1_N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    /// @notice The AgentPayAccountV3 implementation this factory deployed and
    ///         every proxy it creates points at.
    /// @dev Immutable is correct here: this contract is deployed directly rather
    ///      than behind a proxy, so the value is read from its own bytecode.
    address public immutable implementation;

    /// @dev Grouped so the deploy path stays within the EVM stack limit and so
    ///      callers cannot silently transpose two same-typed addresses.
    struct AccountInit {
        address defaultAdmin;
        address owner;
        address executor;
        address upgrader;
        address[] allowedTokens;
        address[] allowedRouteTargets;
    }

    /// @dev The implementation is deployed here rather than accepted as an
    ///      argument. Validating a supplied address could only ever prove slot
    ///      compatibility: a contract returning the right ERC-1822 UUID behind a
    ///      fallback passes every external check while swallowing the
    ///      initialization delegatecall and producing an account with no roles
    ///      and no payment behaviour -- or with hostile payment behaviour.
    ///
    ///      A pinned runtime code hash would also work, but it is a constant
    ///      someone has to keep correct across compiler settings. Deploying it
    ///      removes the input entirely: there is nothing to misconfigure and
    ///      nothing to verify, because the factory is the origin of the code.
    ///      The ERC-1822 assertion below is kept as a build-time canary in case
    ///      a future edit stops AgentPayAccountV3 being UUPS at all.
    constructor(address defaultAdmin, address initialDeployer) {
        if (defaultAdmin == address(0) || initialDeployer == address(0)) revert ZeroAddress();

        address deployedImplementation = address(new AgentPayAccountV3());

        (bool ok, bytes memory returned) =
            deployedImplementation.staticcall(abi.encodeCall(IERC1822Proxiable.proxiableUUID, ()));
        if (!ok || returned.length != 32 || abi.decode(returned, (bytes32)) != ERC1967Utils.IMPLEMENTATION_SLOT) {
            revert ImplementationNotUUPS();
        }

        implementation = deployedImplementation;
        _grantRole(DEFAULT_ADMIN_ROLE, defaultAdmin);
        _grantRole(DEPLOYER_ROLE, initialDeployer);
    }

    /// @notice Deploys and initializes one account proxy, for an owner who
    ///         signed the exact initialization policy being applied.
    /// @dev Initialization is passed to the proxy constructor rather than made
    ///      as a follow-up call, so there is no window in which the account
    ///      exists uninitialized and open to being claimed.
    function deployAccount(bytes32 salt, AccountInit calldata init, uint256 deadline, bytes calldata ownerSignature)
        external
        onlyRole(DEPLOYER_ROLE)
        returns (address account)
    {
        if (deadline <= block.timestamp) revert AuthorizationExpired(deadline);

        account = predictAccountAddress(salt, init);
        if (account.code.length != 0) revert AccountAlreadyDeployed(account);

        _requireOwnerAuthorization(salt, init, account, deadline, ownerSignature);

        address deployed = address(new ERC1967Proxy{salt: salt}(implementation, _initData(init)));
        assert(deployed == account);

        emit AccountDeployed(deployed, init.owner, init.executor, salt);
    }

    /// @notice The digest the owner must sign to authorize one deployment.
    function hashAccountSetup(bytes32 salt, AccountInit calldata init, address predictedAccount, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                ACCOUNT_SETUP_TYPEHASH,
                address(this),
                implementation,
                block.chainid,
                salt,
                init.defaultAdmin,
                init.owner,
                init.executor,
                init.upgrader,
                keccak256(abi.encodePacked(init.allowedTokens)),
                keccak256(abi.encodePacked(init.allowedRouteTargets)),
                predictedAccount,
                deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this)));
    }

    /// @notice Computes the address `deployAccount` would produce.
    /// @dev The init data is part of the creation code, so the predicted
    ///      address covers the initialization arguments too. Two different
    ///      owners cannot collide on one salt.
    function predictAccountAddress(bytes32 salt, AccountInit calldata init) public view returns (address) {
        bytes32 initCodeHash =
            keccak256(abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(implementation, _initData(init))));

        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
    }

    function _requireOwnerAuthorization(
        bytes32 salt,
        AccountInit calldata init,
        address predictedAccount,
        uint256 deadline,
        bytes calldata signature
    ) private view {
        bytes32 digest = hashAccountSetup(salt, init, predictedAccount, deadline);
        address signer = _tryRecover(digest, signature);

        // The owner named in the policy must be the one who signed it. Recovering
        // any valid signer would let a deployer pair a victim's owner field with
        // its own signature.
        if (signer == address(0) || signer != init.owner) revert InvalidOwnerAuthorization();
    }

    function _initData(AccountInit calldata init) private pure returns (bytes memory) {
        return abi.encodeCall(
            AgentPayAccountV3.initialize,
            (init.defaultAdmin, init.owner, init.executor, init.upgrader, init.allowedTokens, init.allowedRouteTargets)
        );
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
}
